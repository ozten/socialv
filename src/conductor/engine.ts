import { createHash } from "node:crypto";
import { BoardError, MAX_TASKS_PER_BATCH, type Board, type Message, type TaskInBatch } from "openboardlol";
import { formatGateDecision, parseGateReply, REPLY_FORMS, type GateDecision } from "../board/gate.ts";
import { gatesChannel, ALERTS, spendChannel, statusChannel, workChannel } from "../channels.ts";
import { runDir, type Config } from "../config.ts";
import { writeGatePage } from "../review/page.ts";
import type { GateItem } from "../review/types.ts";
import { formatBrief, parseBrief } from "../schemas/brief.ts";
import {
  checkPipeline,
  type FanItem,
  type GateNode,
  type Pipeline,
  type PipelineNode,
  type RunContext,
  type StageNode,
} from "./pipeline.ts";

/** How many times a failed stage task is reopened before the owner is told. */
export const MAX_REOPENS = 2;
/** The lease the conductor takes on a gate, only to complete it. The board's minimum: a claim stranded by a crash between claim and complete ends soonest. */
const GATE_LEASE_SECS = 5;
/** How many reconcile passes in a row may change something before we wait for an event. */
const MAX_PASSES = 20;
/** The board's limit on a task's `needs` (MAX_NEEDS_PER_TASK in openboard-api; the SDK does not export it). */
const MAX_NEEDS = 32;
/** A gate packet's length, under the board's 10,000-character limit on a message. */
const PACKET_MAX = 9500;

/** Errors that mean "the board moved under us": look again. */
const RACES = new Set([
  "task_claimed",
  "task_waiting",
  "task_blocked",
  "task_finished",
  "task_state",
  "claim_lost",
  "claim_not_held",
  "label_conflict",
  "revision_conflict",
]);

/** Event types that can change what the conductor should do. */
const WAKE_TYPES = [
  "message.posted",
  "task.ready",
  "task.released",
  "task.expired",
  "task.completed",
  "task.failed",
  "task.blocked",
  "task.unblocked",
  "task.reopened",
  "task.needs_changed",
  "task.canceled",
];

const UNFINISHED = new Set(["waiting", "ready", "claimed", "blocked", "failed"]);

export type Outcome = "completed" | "rejected";

/** One of this run's tasks, as the snapshot saw it. */
interface Rec {
  msg: Message;
  node: PipelineNode;
  rev: number;
  /** Set on the tasks of a fanned-out stage. */
  shot?: string;
}

class Snapshot {
  readonly byNode = new Map<string, Rec[]>();
  readonly byId = new Map<string, Rec>();

  constructor(readonly recs: Rec[]) {
    for (const rec of recs) {
      this.byId.set(rec.msg.id, rec);
      const list = this.byNode.get(rec.node.name) ?? [];
      list.push(rec);
      this.byNode.set(rec.node.name, list);
    }
    for (const list of this.byNode.values()) {
      list.sort((a, b) => a.rev - b.rev);
    }
  }

  /** The highest revision of a node that has any task. */
  latestRev(name: string): number | undefined {
    return this.byNode.get(name)?.at(-1)?.rev;
  }

  /** Every task of a node at its highest revision: one, or one per shot. */
  latestRecs(name: string): Rec[] {
    const rev = this.latestRev(name);
    return this.byNode.get(name)?.filter((r) => r.rev === rev) ?? [];
  }

  /** The highest revision of one task of a node: the node's own, or one shot's. */
  latest(name: string, shot?: string): Rec | undefined {
    return this.byNode.get(name)?.findLast((r) => r.shot === shot);
  }

  has(name: string, rev: number): boolean {
    return this.byNode.get(name)?.some((r) => r.rev === rev) ?? false;
  }
}

const state = (rec: Rec) => rec.msg.task?.state ?? "unknown";

function isRace(error: unknown): boolean {
  return error instanceof BoardError && RACES.has(error.code);
}

/** The profile part of a handle (`local/echo` -> `echo`), or undefined for a bare handle. */
function profileOf(actor: { handle: string; profile?: string }): string | undefined {
  return actor.profile ?? (actor.handle.includes("/") ? actor.handle.slice(actor.handle.indexOf("/") + 1) : undefined);
}

function shortKey(key: string): string {
  return key.length <= 200 ? key : `${key.slice(0, 120)}-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface DriverOptions {
  log?: (line: string) => void;
}

/**
 * Drives one run. Everything it knows comes from a fresh snapshot of the
 * board on each pass; events only say "look again". Every write carries an
 * idempotency key, or is guarded by the state it reads, so a pass can be
 * repeated, and the process killed, at any point.
 */
export class RunDriver {
  private readonly ctx: RunContext;
  private readonly nodes: Map<string, PipelineNode>;
  /** Keys this process has already posted: saves a round trip, not needed for correctness. */
  private readonly posted = new Set<string>();
  private me = "";
  private startCursor: string | undefined;
  private readonly log: (line: string) => void;

  constructor(
    private readonly config: Config,
    private readonly run: string,
    private readonly pipeline: Pipeline,
    private readonly b: Board,
    options: DriverOptions = {},
  ) {
    checkPipeline(pipeline);
    this.ctx = { run, runDir: runDir(config, run) };
    this.nodes = new Map(pipeline.nodes.map((n) => [n.name, n]));
    this.log = options.log ?? ((line) => process.stderr.write(`[conductor ${run}] ${line}\n`));
  }

  /** Runs until the run completes or is rejected, or `signal` aborts. */
  async drive(signal?: AbortSignal): Promise<Outcome | "aborted"> {
    if (signal?.aborted) return "aborted";
    this.me = (await this.b.me()).actor.handle;
    // A board exists only once something is posted to it, and listing tasks
    // on a board that does not exist fails. Posting first also creates it.
    await this.status("started", `Run ${this.run} started (pipeline ${this.pipeline.name}).`);

    const inner = new AbortController();
    let dirty = true;
    let wake: (() => void) | null = null;
    let streamError: unknown = null;
    const notify = () => {
      dirty = true;
      const w = wake;
      wake = null;
      w?.();
    };
    const onAbort = () => notify();
    signal?.addEventListener("abort", onAbort);

    const follow = async (channel: string, after: string) => {
      try {
        for await (const _event of this.b.events({ channel, types: WAKE_TYPES, after }, { signal: inner.signal })) {
          notify();
        }
      } catch (error) {
        if (!inner.signal.aborted) {
          streamError = error;
          notify();
        }
      }
    };

    let following = false;
    try {
      while (!signal?.aborted) {
        if (streamError) throw streamError;
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        dirty = false;
        let outcome: Outcome | null;
        try {
          outcome = await this.settle(signal);
        } catch (error) {
          if (signal?.aborted) break;
          if (!isRace(error)) throw error;
          this.log(`the board moved under us (${(error as BoardError).code}); looking again`);
          dirty = true;
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        if (outcome) return outcome;
        if (!following && this.startCursor) {
          following = true;
          for (const channel of this.channels()) void follow(channel, this.startCursor);
        }
      }
      return "aborted";
    } finally {
      signal?.removeEventListener("abort", onAbort);
      inner.abort();
    }
  }

  /** Reconciles until a pass changes nothing, the run ends, or `signal` aborts. */
  private async settle(signal?: AbortSignal): Promise<Outcome | null> {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      if (signal?.aborted) return null;
      const result = await this.reconcile();
      if (result === "idle") return null;
      if (result !== "acted") return result;
    }
    this.log(`still changing things after ${MAX_PASSES} passes; waiting for the next event`);
    return null;
  }

  // ----- Snapshot ------------------------------------------------------------

  /** Every channel this run's tasks live in. */
  private channels(): string[] {
    return [workChannel(this.run), spendChannel(this.run), gatesChannel(this.run)];
  }

  private channelOf(node: StageNode): string {
    return node.channel === "spend" ? spendChannel(this.run) : workChannel(this.run);
  }

  private async snapshot(): Promise<Snapshot> {
    const recs: Rec[] = [];
    for (const channel of this.channels()) {
      let after: string | undefined;
      do {
        const page = await this.b.tasks.list({ channel, state: "all", limit: 100, after });
        // The first cursor of the first snapshot is where events are followed from.
        this.startCursor ??= page.cursor;
        for (const { root } of page.tasks) {
          const labels = root.labels ?? {};
          const node = labels.stage ? this.nodes.get(labels.stage) : undefined;
          const rev = Number(labels.rev);
          if (labels.run === this.run && node && Number.isSafeInteger(rev) && root.task) {
            recs.push({ msg: root, node, rev, ...(labels.shot ? { shot: labels.shot } : {}) });
          }
        }
        after = page.next_cursor;
      } while (after);
    }
    return new Snapshot(recs);
  }

  // ----- One pass ------------------------------------------------------------

  /** One pass: read the board, make one round of changes. */
  private async reconcile(): Promise<Outcome | "acted" | "idle"> {
    const snap = await this.snapshot();
    this.itemCache.clear();
    let acted = false;

    // A gate canceled other than for a revision ends the run.
    for (const node of this.pipeline.nodes) {
      if (node.kind !== "gate") continue;
      const gate = snap.latest(node.name);
      if (gate && state(gate) === "canceled") {
        const decision = parseGateReply(gate.msg.task?.reason ?? "");
        if (decision?.kind !== "revise") {
          const reason = decision?.kind === "reject" ? decision.reason : (gate.msg.task?.reason ?? "canceled");
          return this.rejectRun(snap, node, gate, reason);
        }
      }
    }

    for (const rec of snap.recs) {
      const s = state(rec);
      const latestRev = snap.latestRev(rec.node.name)!;
      if (rec.rev < latestRev) {
        // An older revision still open: the newer one replaces it.
        if (UNFINISHED.has(s)) {
          await this.b.tasks.cancel(rec.msg.id, `superseded by revision ${latestRev}`);
          acted = true;
        }
        continue;
      }
      if (rec.node.kind === "stage") {
        if (s === "failed") acted = (await this.onFailed(rec)) || acted;
        if (s === "blocked" && rec.msg.task?.block_kind === "needs_input") acted = (await this.onQuestion(rec)) || acted;
      } else if (s === "ready" || s === "blocked") {
        const result = await this.onGate(rec, rec.node);
        if (result === "acted") acted = true;
      }
      if (s === "waiting" || s === "ready" || s === "blocked") acted = (await this.repoint(snap, rec)) || acted;
    }
    if (acted) return "acted";

    if (await this.expand(snap)) return "acted";

    let done = true;
    for (const node of this.pipeline.nodes) {
      const recs = snap.latestRecs(node.name);
      done = recs.length > 0 && recs.every((r) => state(r) === "completed");
      if (done && node.kind === "stage" && node.fanOut) done = recs.length >= (await this.items(node)).length;
      if (!done) break;
    }
    if (done) {
      await this.status("completed", `Run ${this.run} completed.`);
      return "completed";
    }
    return "idle";
  }

  // ----- Creating tasks (staged expansion and rework) ------------------------

  /** The items of a fanned-out stage, read once per pass. */
  private readonly itemCache = new Map<string, Promise<FanItem[]>>();

  private items(node: StageNode): Promise<FanItem[]> {
    let items = this.itemCache.get(node.name);
    if (!items) {
      items = node.fanOut!.items(this.ctx).then((list) => {
        const shots = new Set(list.map((i) => i.shot));
        if (list.length === 0 || shots.size !== list.length) {
          throw new Error(`stage ${node.name}: expected one or more items with distinct shots, got ${list.length}`);
        }
        return list;
      });
      this.itemCache.set(node.name, items);
    }
    return items;
  }

  /** Creates what should exist and does not. True if it created anything. */
  private async expand(snap: Snapshot): Promise<boolean> {
    // A fanned-out stage left part-created (by a crash between chunks) is finished first.
    for (const node of this.pipeline.nodes) {
      if (node.kind !== "stage" || !node.fanOut) continue;
      const recs = snap.latestRecs(node.name);
      if (recs.length === 0) continue;
      const have = new Set(recs.map((r) => r.shot));
      const items = await this.items(node);
      if (items.every((i) => have.has(i.shot))) continue;
      const first = recs[0]!;
      await this.createFanOut(node, first.rev, parseBrief(first.msg.text).notes, first.msg.task?.needs ?? [], items, have);
      return true;
    }

    const plan = new Map<string, { rev: number; notes: string | null }>();

    // Rework: a gate canceled with `revise` gets its stages and itself again, one revision up.
    for (const node of this.pipeline.nodes) {
      if (node.kind !== "gate") continue;
      const gate = snap.latest(node.name);
      const decision = gate && state(gate) === "canceled" ? parseGateReply(gate.msg.task?.reason ?? "") : null;
      if (!gate || decision?.kind !== "revise") continue;
      const rev = gate.rev + 1;
      for (const name of [...node.rework, node.name]) {
        if (!snap.has(name, rev)) plan.set(name, { rev, notes: decision.notes });
      }
    }
    // Staged expansion: every node with no task yet, created below once what it needs allows.
    for (const node of this.pipeline.nodes) {
      if (snap.latestRev(node.name) === undefined && !plan.has(node.name)) plan.set(node.name, { rev: 1, notes: null });
    }

    // In pipeline order, so a node can need one created earlier in this pass.
    const created = new Map<string, string[]>();
    for (const node of this.pipeline.nodes) {
      const entry = plan.get(node.name);
      if (!entry) continue;
      const needs = this.needIds(snap, node, plan, created);
      if (!needs) continue;
      const { rev, notes } = entry;
      if (node.kind === "gate") {
        created.set(node.name, [await this.createGate(node, rev, notes, needs)]);
      } else if (node.fanOut) {
        created.set(node.name, await this.createFanOut(node, rev, notes, needs, await this.items(node), new Set()));
      } else {
        const { task } = await this.b.tasks.create(this.channelOf(node), {
          text: formatBrief(node.summary, this.brief(node, notes, node)),
          labels: { run: this.run, stage: node.name, rev: String(rev), kind: "stage" },
          needs,
          for: node.role,
          id: shortKey(`${this.run}-${node.name}-r${rev}`),
        });
        created.set(node.name, [task.id]);
        this.log(`created ${node.name} r${rev}`);
      }
    }
    return created.size > 0;
  }

  /**
   * The task IDs `node` should need, or null when it cannot be created yet:
   * something it needs has no task (or is waiting to be created this pass),
   * a gate it needs is not approved, or, for a fanned-out stage, something
   * it needs has not completed. A fanned-out need contributes its tasks that
   * have not completed, so a stage after a large fan-out waits until few
   * enough are left to fit the board's limit on needs.
   */
  private needIds(
    snap: Snapshot,
    node: PipelineNode,
    plan: Map<string, unknown>,
    created: Map<string, string[]>,
  ): string[] | null {
    const mustBeDone = (needed: PipelineNode) => needed.kind === "gate" || (node.kind === "stage" && node.fanOut !== undefined);
    const ids: string[] = [];
    for (const need of node.needs) {
      const needed = this.nodes.get(need)!;
      const fresh = created.get(need);
      if (fresh) {
        if (mustBeDone(needed)) return null;
        ids.push(...fresh);
        continue;
      }
      if (plan.has(need)) return null;
      const recs = snap.latestRecs(need);
      if (recs.length === 0) return null;
      if (mustBeDone(needed) && !recs.every((r) => state(r) === "completed")) return null;
      const open = needed.kind === "stage" && needed.fanOut ? recs.filter((r) => state(r) !== "completed") : recs;
      ids.push(...open.map((r) => r.msg.id));
    }
    return ids.length <= MAX_NEEDS ? ids : null;
  }

  private brief(node: StageNode, notes: string | null, item: { inputs: string[]; output: string; shot?: string }) {
    return {
      v: 1 as const,
      run: this.run,
      stage: node.name,
      role: node.role,
      ...(item.shot ? { shot: item.shot } : {}),
      inputs: item.inputs,
      output: item.output,
      schema: node.schema,
      params: node.params,
      notes,
    };
  }

  /**
   * Creates the tasks of a fanned-out stage that do not exist yet, in chunks
   * the size of the board's batch limit. A chunk is atomic, and its key names
   * the revision and its first and last shot, so a chunk is either all there
   * or sent again under the same key. Returns the IDs created.
   */
  private async createFanOut(
    node: StageNode,
    rev: number,
    notes: string | null,
    needs: string[],
    items: FanItem[],
    have: Set<string | undefined>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < items.length; i += MAX_TASKS_PER_BATCH) {
      const chunk = items.slice(i, i + MAX_TASKS_PER_BATCH);
      if (chunk.some((item) => have.has(item.shot))) continue;
      const batch: TaskInBatch[] = chunk.map((item) => ({
        text: formatBrief(item.summary, this.brief(node, notes, item)),
        labels: { run: this.run, stage: node.name, rev: String(rev), kind: "stage", shot: item.shot },
        needs,
        for: node.role,
      }));
      const key = shortKey(`${this.run}-${node.name}-r${rev}-${chunk[0]!.shot}-${chunk.at(-1)!.shot}`);
      const tasks = await this.b.tasks.createMany(this.channelOf(node), batch, { id: key });
      ids.push(...tasks.map((t) => t.id));
      this.log(`created ${node.name} r${rev} for ${chunk.map((c) => c.shot).join(", ")}`);
    }
    return ids;
  }

  /** A gate lives in the gates channel, kept for the conductor itself. */
  private async createGate(node: GateNode, rev: number, notes: string | null, needs: string[]): Promise<string> {
    const text = [
      `Approval needed: ${node.title}${rev > 1 ? ` (revision ${rev})` : ""}`,
      "",
      node.summary,
      ...(notes ? ["", `Rework notes: ${notes}`] : []),
    ].join("\n");
    const { task } = await this.b.tasks.create(gatesChannel(this.run), {
      text,
      labels: { run: this.run, stage: node.name, rev: String(rev), kind: "gate" },
      needs,
      for: profileOf({ handle: this.me }) ?? this.me,
      id: `${this.run}-${node.name}-r${rev}`,
    });
    this.log(`created gate ${node.name} r${rev}`);
    return task.id;
  }

  /** Points an open task's needs at the latest revision of what it needs. */
  private async repoint(snap: Snapshot, rec: Rec): Promise<boolean> {
    const needs = rec.msg.task?.needs ?? [];
    const next = needs.map((id) => {
      const needed = snap.byId.get(id);
      return needed ? (snap.latest(needed.node.name, needed.shot)?.msg.id ?? id) : id;
    });
    if (next.every((id, i) => id === needs[i])) return false;
    await this.b.tasks.needs(rec.msg.id, next);
    this.log(`re-pointed ${this.label(rec)} at the latest revisions`);
    return true;
  }

  // ----- Gates ----------------------------------------------------------------

  private gateId(node: GateNode, rev: number): string {
    return `${node.name}-${rev}`;
  }

  private async gateItems(node: GateNode): Promise<GateItem[]> {
    const stages = node.needs.map((n) => this.nodes.get(n)).filter((n): n is StageNode => n?.kind === "stage");
    return node.items(this.ctx, stages);
  }

  private async onGate(rec: Rec, node: GateNode): Promise<"acted" | "idle"> {
    const thread = await this.b.thread(rec.msg.id);
    const replies = thread.replies.filter((r) => !r.deleted_at);
    const packetAt = replies.findIndex((r) => r.by.handle === this.me);
    const keyBase = `${this.run}-${node.name}-r${rec.rev}`;

    if (packetAt < 0) {
      if (state(rec) !== "ready") return "idle";
      await this.postPacket(rec, node, keyBase);
      return "acted";
    }
    // A process that died between the packet and the status line left the status unsaid.
    await this.openedStatus(rec, node);

    let items: GateItem[] | undefined;
    for (const reply of replies.slice(packetAt + 1)) {
      if (reply.by.handle !== this.config.owner) continue;
      const decision = parseGateReply(reply.text);
      let problem: string | null = decision ? null : "I did not understand that.";
      if (decision?.kind === "approve" && decision.items) {
        items ??= await this.gateItems(node);
        const count = items.length;
        if (decision.items.some((n) => n > count)) {
          problem = `This packet has ${count} item${count === 1 ? "" : "s"}.`;
        }
      }
      if (problem || !decision) {
        await this.replyOnce(
          rec.msg.id,
          `${keyBase}-help-${reply.id}`,
          `@${this.config.owner} ${problem} Reply in this thread with one of:\n\n${REPLY_FORMS}`,
        );
        continue;
      }
      return this.decide(rec, node, decision, reply, keyBase, items ?? (await this.gateItems(node)));
    }

    if (state(rec) === "ready") {
      await this.blockGate(rec);
      return "acted";
    }
    return "idle";
  }

  private async postPacket(rec: Rec, node: GateNode, keyBase: string): Promise<void> {
    const items = await this.gateItems(node);
    const relative = await writeGatePage(this.ctx.runDir, {
      run: this.run,
      gate: this.gateId(node, rec.rev),
      title: node.title,
      summary: node.summary,
      items,
      threadId: rec.msg.id,
    });
    const link = this.pageLink(relative);
    const packet = (lines: string[]) =>
      [
        `@${this.config.owner} **${node.title}** (revision ${rec.rev})`,
        "",
        node.summary,
        "",
        ...lines,
        "",
        `Review page: ${link}`,
        "",
        `Reply in this thread with one of:`,
        "",
        REPLY_FORMS,
      ].join("\n");
    const line = (item: GateItem, max: number) => {
      const body = item.text !== undefined && max > 0 ? `: ${clip(item.text, max)}` : "";
      const file = item.file ? ` (\`${item.file}\`)` : "";
      return `${item.n}. **${item.label}**${file}${body}`;
    };
    // The board caps a message at 10,000 characters. Many items share the
    // room; if even their names do not fit, the packet lists the first ones and
    // sends the owner to the review page, which always shows everything.
    let text = packet(items.map((item) => line(item, 800)));
    for (const max of [300, 120, 0]) {
      if (text.length <= PACKET_MAX) break;
      text = packet(items.map((item) => line(item, max)));
    }
    for (let shown = items.length - 1; text.length > PACKET_MAX && shown > 0; shown--) {
      const rest = items.length - shown;
      text = packet([...items.slice(0, shown).map((item) => line(item, 0)), `…and ${rest} more item${rest === 1 ? "" : "s"}: see the review page.`]);
    }
    await this.replyOnce(rec.msg.id, `${keyBase}-packet`, text);
    await this.openedStatus(rec, node);
    await this.blockGate(rec);
  }

  private pageLink(relative: string): string {
    return `${this.config.reviewUrl.replace(/\/+$/, "")}/runs/${this.run}/${relative.split("\\").join("/")}`;
  }

  private openedStatus(rec: Rec, node: GateNode): Promise<void> {
    const link = this.pageLink(`review/${this.gateId(node, rec.rev)}.html`);
    return this.status(`${node.name}-r${rec.rev}-opened`, `Gate ${node.name} (revision ${rec.rev}) is open: ${node.title}. ${link}`);
  }

  private async blockGate(rec: Rec): Promise<void> {
    await this.b.tasks.block(rec.msg.id, `Waiting for @${this.config.owner} to decide. Reply in this thread.`, {
      kind: "approval",
    });
  }

  private async decide(
    rec: Rec,
    node: GateNode,
    decision: GateDecision,
    reply: Message,
    keyBase: string,
    items: GateItem[],
  ): Promise<"acted" | "idle"> {
    const text = formatGateDecision(decision);
    await this.replyOnce(rec.msg.id, `${keyBase}-receipt`, `Received \`${text}\` from ${reply.by.handle} (${reply.id}).`);
    await this.status(`${node.name}-r${rec.rev}-decided`, `Gate ${node.name} (revision ${rec.rev}): ${text}`);

    if (decision.kind !== "approve") {
      await this.b.tasks.cancel(rec.msg.id, text);
      this.log(`gate ${node.name} r${rec.rev}: ${text}`);
      return "acted";
    }

    // Approve: unblock, claim, complete. A claim left by a process that died
    // here cannot be completed without its token; it ends with its lease.
    let s = state(rec);
    if (s === "blocked") {
      s = (await this.b.tasks.unblock(rec.msg.id)).task?.state ?? "unknown";
    }
    if (s !== "ready") return s === "blocked" ? "idle" : "acted";
    const claim = await this.b.tasks.claim(rec.msg.id, { lease: GATE_LEASE_SECS });
    const approved = decision.items ?? items.map((i) => i.n);
    await claim.complete(`${text}\napproved items: ${approved.join(",") || "none"}\ndecision: ${reply.id} by ${reply.by.handle}`);
    this.log(`gate ${node.name} r${rec.rev}: ${text}`);
    return "acted";
  }

  private async rejectRun(snap: Snapshot, node: GateNode, gate: Rec, reason: string): Promise<Outcome> {
    for (const rec of snap.recs) {
      if (UNFINISHED.has(state(rec))) {
        try {
          await this.b.tasks.cancel(rec.msg.id, `run rejected: ${reason}`);
        } catch (error) {
          if (!(error instanceof BoardError && error.code === "task_finished")) throw error;
        }
      }
    }
    await this.status("rejected", `Run ${this.run} rejected at gate ${node.name} (revision ${gate.rev}): ${reason}`);
    return "rejected";
  }

  // ----- Stage tasks ------------------------------------------------------------

  /** Reopens a failed task up to MAX_REOPENS times, then tells the owner. */
  private async onFailed(rec: Rec): Promise<boolean> {
    const task = rec.msg.task!;
    const labels = rec.msg.labels ?? {};
    const epoch = String(task.epoch);
    const attempts = Number(labels.attempts ?? "0");
    // `attempt-epoch` says which failure the count already covers, so a
    // restart between the label and the reopen does not count twice.
    if (labels["attempt-epoch"] !== epoch) {
      if (attempts >= MAX_REOPENS) {
        await this.postOnce(
          ALERTS,
          `${this.run}-${rec.node.name}-r${rec.rev}${rec.shot ? `-${rec.shot}` : ""}-failed`,
          `@${this.config.owner} Stage ${rec.node.name}${rec.shot ? ` (${rec.shot})` : ""} (revision ${rec.rev}) of run ${this.run} failed ${attempts + 1} times and is left failed. Last reason: ${clip(task.reason ?? "none given", 2000)} (task ${rec.msg.id})`,
        );
        return false;
      }
      await this.b.label(rec.msg.id, {
        set: { attempts: String(attempts + 1), "attempt-epoch": epoch },
        if: { attempts: labels.attempts ?? null },
      });
    }
    await this.b.tasks.reopen(rec.msg.id);
    this.log(`reopened ${this.label(rec)} (attempt ${attempts + 2})`);
    return true;
  }

  /** Unblocks a task that asked a question once someone other than its role has answered. */
  private async onQuestion(rec: Rec): Promise<boolean> {
    const task = rec.msg.task!;
    let role = (rec.node as StageNode).role;
    try {
      role = parseBrief(rec.msg.text).role;
    } catch {
      // keep the pipeline's role
    }
    const blockedAt = Date.parse(task.changed_at);
    const thread = await this.b.thread(rec.msg.id);
    const answer = thread.replies.find(
      (r) =>
        !r.deleted_at &&
        r.by.handle !== this.me &&
        profileOf(r.by) !== role &&
        Date.parse(r.created_at) > blockedAt,
    );
    if (!answer) return false;
    await this.b.tasks.unblock(rec.msg.id);
    this.log(`unblocked ${this.label(rec)}: ${answer.by.handle} answered`);
    return true;
  }

  private label(rec: Rec): string {
    return `${rec.node.name}${rec.shot ? ` ${rec.shot}` : ""} r${rec.rev}`;
  }

  // ----- Posting ---------------------------------------------------------------

  private status(key: string, text: string): Promise<void> {
    return this.postOnce(statusChannel(this.run), `${this.run}-status-${key}`, text);
  }

  private postOnce(channel: string, key: string, text: string): Promise<void> {
    return this.once(key, () => this.b.post(channel, { text, id: shortKey(key) }));
  }

  private replyOnce(thread: string, key: string, text: string): Promise<void> {
    return this.once(key, () => this.b.reply(thread, { text, id: shortKey(key) }));
  }

  private async once(key: string, write: () => Promise<unknown>): Promise<void> {
    if (this.posted.has(key)) return;
    try {
      await write();
    } catch (error) {
      // The key was used with other text by an earlier process: the message exists.
      if (!(error instanceof BoardError && error.code === "idempotency_conflict")) throw error;
    }
    this.posted.add(key);
  }
}

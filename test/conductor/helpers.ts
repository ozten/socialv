import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClaimedTask, Message } from "openboardlol";
import { gatesChannel, workChannel } from "../../src/channels.ts";
import { runDir, type Config } from "../../src/config.ts";
import { runConductor } from "../../src/conductor/index.ts";
import { parseBrief, type Brief } from "../../src/schemas/brief.ts";
import type { TestBoard } from "../helpers/board.ts";

export function testConfig(tb: TestBoard): Config {
  return {
    boardUrl: tb.url,
    boardName: tb.name,
    owner: "local",
    projectDir: tb.projectDir,
    reviewUrl: "http://review.test",
    runtime: "fake",
  };
}

const quiet = process.env.DEBUG ? undefined : () => {};

/** Starts the conductor for a run; `stop()` aborts it and returns its outcome. */
export function startConductor(tb: TestBoard, run: string) {
  const controller = new AbortController();
  const done = runConductor(testConfig(tb), { run, signal: controller.signal, log: quiet });
  return {
    done,
    async stop() {
      controller.abort();
      return done;
    },
  };
}

/** What a fake worker does with a claimed task. Return normally to have the default work done. */
export type Behavior = (claim: ClaimedTask, brief: Brief) => Promise<"handled" | void>;

/** Does the fake work for a brief: writes the output file under the run folder. */
export async function fakeWork(config: Config, brief: Brief): Promise<void> {
  const dir = runDir(config, brief.run);
  let text: string;
  if (brief.role === "toy-writer") {
    text = `a tale of ${String(brief.params.topic)}${brief.notes ? ` (${brief.notes})` : ""}`;
  } else {
    const input = JSON.parse(await readFile(path.join(dir, brief.inputs[0]!), "utf8")) as { text: string };
    text = brief.params.op === "uppercase" ? input.text.toUpperCase() : `${input.text} [stamped]`;
  }
  const target = path.join(dir, brief.output);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(`${target}.tmp`, JSON.stringify({ text }));
  await rename(`${target}.tmp`, target);
}

/** A worker for `role` on one run's work channel, written with the SDK. */
export function startWorker(tb: TestBoard, run: string, role: string, behavior?: Behavior) {
  const controller = new AbortController();
  const handle = tb.as(role);
  const config = testConfig(tb);
  const loop = (async () => {
    while (!controller.signal.aborted) {
      let claim: ClaimedTask | null;
      try {
        claim = await handle.tasks.claim({ channel: workChannel(run), wait: 2 }, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
      if (!claim) continue;
      const brief = parseBrief(claim.task.text);
      if ((await behavior?.(claim, brief)) === "handled") continue;
      await fakeWork(config, brief);
      await claim.complete(`done\n${brief.output}`);
    }
  })();
  return {
    async stop() {
      controller.abort();
      await loop;
    },
  };
}

export function startWorkers(tb: TestBoard, run: string, behaviors: Record<string, Behavior> = {}) {
  const workers = ["toy-writer", "echo"].map((role) => startWorker(tb, run, role, behaviors[role]));
  return { stop: () => Promise.all(workers.map((w) => w.stop())) };
}

export async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function tasksIn(tb: TestBoard, channel: string): Promise<Message[]> {
  const out: Message[] = [];
  let after: string | undefined;
  do {
    const page = await tb.as("observer").tasks.list({ channel, state: "all", limit: 100, after });
    out.push(...page.tasks.map((t) => t.root));
    after = page.next_cursor;
  } while (after);
  return out;
}

export async function runTasks(tb: TestBoard, run: string) {
  const work = await tasksIn(tb, workChannel(run));
  const gates = await tasksIn(tb, gatesChannel(run));
  const find = (stage: string, rev = 1) =>
    [...work, ...gates].find((t) => t.labels?.stage === stage && t.labels?.rev === String(rev));
  return { work, gates, find };
}

/** Waits until gate `rev` of the run is blocked for approval, and returns it. */
export function gateBlocked(tb: TestBoard, run: string, rev = 1) {
  return waitFor(`gate r${rev} blocked`, async () => {
    const gate = (await runTasks(tb, run)).find("review", rev);
    return gate?.task?.state === "blocked" && gate.task.block_kind === "approval" ? gate : null;
  });
}

export async function threadsIn(tb: TestBoard, channel: string): Promise<Message[]> {
  const list = await tb.as("observer").threads({ channel, limit: 100 });
  return list.threads.map((t) => t.root);
}

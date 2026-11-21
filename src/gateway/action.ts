// The one path every paid call takes (design 7):
//
//   load → verify approval (over the auto-approve limit) → budget check → consume → submit → record → wait → save
//
// An action is identified by its task and operation, so a re-run of the same
// task finds the same ledger row and never submits twice.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.ts";
import { inside, writeAtomic } from "../step/files.ts";
import { readBudget, spendingStopped, stopSpendFile } from "./budget.ts";
import { appendCostLog, type CostLogLine } from "./cost-log.ts";
import { Ledger, type ActionRow } from "./ledger.ts";
import type { Notifier } from "./notify.ts";
import { estimate, type Estimate, type PriceBasis } from "./prices.ts";

/** A paid provider reached through a queue: submit, then wait on the request ID. */
export interface QueueProvider {
  /** Provider name, for records. */
  readonly name: string;
  /** Throws (MissingKeyError) when the provider cannot be called. Checked before consuming. */
  ready(): void;
  /** Turns the logical input into the provider's request, e.g. by uploading a file. Sends nothing billable. */
  prepare(endpoint: string, input: unknown): Promise<unknown>;
  /** Enqueues the request; returns the provider's request ID. Throw SubmitRejected when it was definitely not accepted. */
  submit(endpoint: string, request: unknown): Promise<string>;
  /** Waits for the request and returns its JSON result. Throw JobFailed when the provider says it failed. */
  wait(endpoint: string, requestId: string, opts: { timeoutMs: number }): Promise<unknown>;
}

/** The provider definitely did not accept the request: nothing was billed. */
export class SubmitRejected extends Error {}
/** The provider ran the request and reports it failed. */
export class JobFailed extends Error {}
/** The gateway will not spend on this action. The task fails with this reason. */
export class GatewayRefusal extends Error {}

/** Test-only points where a test can simulate the gateway dying. */
export interface CrashHooks {
  afterConsume?: () => void | Promise<void>;
  afterSubmit?: () => void | Promise<void>;
  afterSucceeded?: () => void | Promise<void>;
}

export interface GatewayContext {
  config: Config;
  run: string;
  /** The run folder, absolute. */
  runDir: string;
  taskId: string;
  /** The board claim epoch this attempt holds. */
  epoch: number;
  notify: Notifier;
  /** How long to wait on a provider request before giving up this attempt. */
  waitTimeoutMs?: number;
  hooks?: CrashHooks;
}

export interface PaidRequest {
  operation: string;
  endpoint: string;
  /** The logical request. Its digest binds the action (and, in M2, the approval). */
  input: unknown;
  /** What the price table needs to estimate the request. */
  basis: PriceBasis;
  provider: QueueProvider;
  /** The action's ID when it is fixed before the task exists (an envelope's). Default: from the task and operation. */
  actionId?: string;
  /**
   * Checks that the owner approved exactly this request, for one over the
   * auto-approve limit. Throws GatewayRefusal when they did not. Returns a
   * line naming the approval, for the cost log.
   */
  approval?: () => Promise<string>;
}

export interface PaidOutcome {
  /** The provider's JSON result. */
  result: unknown;
  row: ActionRow;
  /** True when the result came from an earlier attempt's record. */
  replayed: boolean;
}

const DEFAULT_WAIT_MS = 15 * 60_000;

export function actionIdFor(taskId: string, operation: string): string {
  return `${taskId}-${operation}`;
}

/** SHA-256 of the canonical JSON (sorted keys) of `value`. */
export function inputDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function runPaidAction(ctx: GatewayContext, req: PaidRequest): Promise<PaidOutcome> {
  const { config, run, runDir, taskId } = ctx;
  const actionId = req.actionId ?? actionIdFor(taskId, req.operation);
  const base = { run, task_id: taskId, action_id: actionId, operation: req.operation, endpoint: req.endpoint };
  const log = (line: Omit<CostLogLine, keyof typeof base>) => appendCostLog(runDir, { ...base, ...line });
  const refuse = (reason: string, est?: Estimate): never => {
    log({ event: "refused", estimated_usd: est?.estimated_usd, max_cost_usd: est?.max_cost_usd, note: reason });
    throw new GatewayRefusal(reason);
  };

  // Kill switch: refuse everything.
  if (spendingStopped(config.projectDir)) {
    refuse(`spending is stopped (${stopSpendFile(config.projectDir)} exists)`);
  }

  // Load: price the request and bind it to its digest.
  let est: Estimate;
  try {
    est = estimate(req.endpoint, req.basis);
  } catch (error) {
    return refuse((error as Error).message);
  }
  const digest = inputDigest(req.input);

  const ledger = new Ledger(runDir, config.projectDir);
  try {
    const prior = ledger.get(actionId);
    if (prior && !(prior.state === "failed" && prior.request_id === null)) {
      return await resume(ctx, req, ledger, prior, digest, log);
    }

    const budget = readBudget(config.projectDir);
    if (est.max_cost_usd > budget.auto_approve_usd) {
      if (!req.approval) {
        refuse(
          `${req.operation} on ${req.endpoint} may cost up to $${est.max_cost_usd.toFixed(4)}, over the auto-approve limit ` +
            `of $${budget.auto_approve_usd.toFixed(2)}, and this operation has no approval gate`,
          est,
        );
      }
      // The owner's approval of this action and digest, read from the gate thread (design 7, step 2).
      let approvedBy: string;
      try {
        approvedBy = await req.approval!();
      } catch (error) {
        if (!(error instanceof GatewayRefusal)) throw error;
        return refuse(`not approved: ${error.message}`, est);
      }
      log({ event: "approved", estimated_usd: est.estimated_usd, max_cost_usd: est.max_cost_usd, note: approvedBy });
    }

    req.provider.ready();

    const consumed = ledger.consume(
      { ...base, input_digest: digest, estimated_usd: est.estimated_usd, max_cost_usd: est.max_cost_usd, epoch: ctx.epoch },
      budget,
    );
    if (consumed.kind === "over_cap") {
      const what = consumed.cap === "run" ? `run ${run}` : "today (UTC, all runs)";
      const reason =
        `${req.operation} refused: up to $${est.max_cost_usd.toFixed(4)} would take ${what} over its cap ` +
        `($${consumed.spent.toFixed(4)} committed of $${consumed.limit.toFixed(2)})`;
      await ctx.notify.ops(`@${config.owner} Spending cap reached. ${reason}. Task ${taskId}.`, `${actionId}-cap-${consumed.cap}`);
      refuse(reason, est);
    }
    if (consumed.kind === "existing") {
      // Another gateway recorded it between our read and our transaction.
      return await resume(ctx, req, ledger, consumed.row, digest, log);
    }
    await ctx.hooks?.afterConsume?.();

    // Submit. Anything before the provider accepts the request costs nothing.
    let requestId: string;
    try {
      if (spendingStopped(config.projectDir)) {
        throw new GatewayRefusal(`spending is stopped (${stopSpendFile(config.projectDir)} exists)`);
      }
      const request = await req.provider.prepare(req.endpoint, req.input);
      try {
        requestId = await req.provider.submit(req.endpoint, request);
      } catch (error) {
        if (error instanceof SubmitRejected) throw error;
        // We cannot tell whether the provider accepted it: a person must reconcile.
        const reason = `submit to ${req.endpoint} ended without an answer (${message(error)}); outcome unknown, not resent`;
        ledger.recordUnknown(actionId, reason);
        log({ event: "outcome_unknown", estimated_usd: est.estimated_usd, max_cost_usd: est.max_cost_usd, note: reason });
        await ctx.notify.ops(`@${config.owner} Paid action ${actionId} has an unknown outcome: ${reason}. Check the provider before reopening.`, `${actionId}-unknown`);
        throw new GatewayRefusal(reason);
      }
    } catch (error) {
      if (error instanceof GatewayRefusal && ledger.get(actionId)?.state === "outcome_unknown") throw error;
      const reason = `not sent: ${message(error)}`;
      ledger.recordFailed(actionId, reason);
      log({ event: "failed", estimated_usd: est.estimated_usd, max_cost_usd: est.max_cost_usd, note: reason });
      throw error;
    }

    // Record the request ID before waiting, so a crash from here on resumes it.
    const row = ledger.recordSubmitted(actionId, requestId);
    log({ event: "submitted", request_id: requestId, estimated_usd: est.estimated_usd, max_cost_usd: est.max_cost_usd });
    await ctx.notify.thread(
      `Submitted ${req.operation} to ${req.endpoint}: estimated $${est.estimated_usd.toFixed(4)} (at most $${est.max_cost_usd.toFixed(4)}), request ${requestId}`,
      `${actionId}-submitted-${requestId}`,
    );
    if (row.state !== "submitted") {
      throw new GatewayRefusal(`action ${actionId} was marked ${row.state} while it was being submitted (request ${requestId})`);
    }
    await ctx.hooks?.afterSubmit?.();
    return await finish(ctx, req, ledger, row, log);
  } finally {
    ledger.close();
  }
}

/** A second attempt on a recorded action. Never submits. */
async function resume(
  ctx: GatewayContext,
  req: PaidRequest,
  ledger: Ledger,
  row: ActionRow,
  digest: string,
  log: (line: Omit<CostLogLine, "run" | "task_id" | "action_id" | "operation" | "endpoint">) => void,
): Promise<PaidOutcome> {
  const { config } = ctx;
  if (row.input_digest !== digest || row.endpoint !== req.endpoint) {
    throw new GatewayRefusal(`action ${row.action_id} was recorded for a different request; the task's input changed after it was paid for`);
  }
  switch (row.state) {
    case "succeeded": {
      const result = JSON.parse(await readFile(inside(ctx.runDir, row.output_path!), "utf8")) as unknown;
      log({ event: "replayed", request_id: row.request_id, actual_usd: 0, note: "recorded result returned; nothing submitted" });
      return { result, row, replayed: true };
    }
    case "submitted":
      return finish(ctx, req, ledger, row, log);
    case "consumed": {
      if (row.epoch === ctx.epoch) {
        // The same claim is still in the middle of submitting it.
        throw new GatewayRefusal(`action ${row.action_id} is being submitted by another process under this claim`);
      }
      const reason = `the gateway stopped after consuming action ${row.action_id} and before recording a request ID; it may or may not have reached ${row.endpoint}`;
      ledger.recordUnknown(row.action_id, reason);
      log({ event: "outcome_unknown", estimated_usd: row.estimated_usd, max_cost_usd: row.max_cost_usd, note: reason });
      await ctx.notify.ops(
        `@${config.owner} Paid action ${row.action_id} (task ${row.task_id}, run ${row.run}) has an unknown outcome: ${reason}. It will not be resent; check the provider and decide.`,
        `${row.action_id}-unknown`,
      );
      throw new GatewayRefusal(`outcome unknown for action ${row.action_id}: not resubmitted; the owner was alerted in ops`);
    }
    case "outcome_unknown":
      throw new GatewayRefusal(`outcome unknown for action ${row.action_id}: not resubmitted; a person must reconcile it (${row.error ?? ""})`);
    case "failed":
      throw new GatewayRefusal(`action ${row.action_id} failed at the provider (request ${row.request_id}): ${row.error ?? ""}; not resent under the same task`);
  }
}

/** Waits on a recorded request, saves its JSON result and records success. */
async function finish(
  ctx: GatewayContext,
  req: PaidRequest,
  ledger: Ledger,
  row: ActionRow,
  log: (line: Omit<CostLogLine, "run" | "task_id" | "action_id" | "operation" | "endpoint">) => void,
): Promise<PaidOutcome> {
  const requestId = row.request_id!;
  let result: unknown;
  try {
    result = await req.provider.wait(req.endpoint, requestId, { timeoutMs: ctx.waitTimeoutMs ?? DEFAULT_WAIT_MS });
  } catch (error) {
    if (error instanceof JobFailed) {
      const reason = `request ${requestId} failed at the provider: ${error.message}`;
      ledger.recordFailed(row.action_id, reason);
      log({ event: "failed", request_id: requestId, estimated_usd: row.estimated_usd, max_cost_usd: row.max_cost_usd, note: reason });
      throw new GatewayRefusal(reason);
    }
    // Still running, or the provider was unreachable: the row stays `submitted` and a re-run resumes it.
    throw new Error(`still waiting on request ${requestId} (${message(error)}); a re-run of this task resumes it without resubmitting`);
  }
  const rel = path.join("manifests", "actions", `${row.action_id}.json`);
  await writeAtomic(inside(ctx.runDir, rel), `${JSON.stringify(result, null, 2)}\n`);
  // fal does not report a per-request cost in its result: the price-table estimate is recorded as the cost.
  const done = ledger.recordSucceeded(row.action_id, row.estimated_usd, rel);
  log({ event: "succeeded", request_id: requestId, estimated_usd: row.estimated_usd, max_cost_usd: row.max_cost_usd, actual_usd: done.actual_usd, note: "cost from the price table" });
  await ctx.hooks?.afterSucceeded?.();
  return { result, row: done, replayed: false };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

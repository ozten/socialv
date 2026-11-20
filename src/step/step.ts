// `socialv step <role>`: one task, under `openboard tasks run`. Reads the
// task named by BOARD_TASK, runs the role's executor, validates the output,
// writes it atomically and settles the task through the claim `tasks run`
// handed us. If the agent blocked the task to ask a question, it leaves the
// task as it is.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { BoardError, type Board, type Message } from "openboardlol";
import { connect } from "../board/connect.ts";
import { handleOf, runDir, type Config } from "../config.ts";
import { parseBrief, type Brief } from "../schemas/brief.ts";
import { promptFor } from "../workers/agents/common.ts";
import { getRole } from "../workers/registry.ts";
import type { AgentRole, AgentTaskContext, ToolRole } from "../workers/types.ts";
import { inside, readIfExists, readJson, sha256, writeAtomic } from "./files.ts";
import { SessionNotFoundError, sessionEnv, type RunResult, type Usage } from "./runtime.ts";
import { check, getSchema } from "./schemas.ts";
import { selectRuntime } from "./select-runtime.ts";

/** Questions a task may ask before it is handed to the owner. */
export const MAX_QUESTIONS = 3;
/** How long an agent waits once for an answer. */
const WAIT_SECS = 240;
/** The task-root label holding the agent's session ID. */
export const SESSION_LABEL = "session";

type Outcome = { kind: "done"; value: unknown; summary: string } | { kind: "blocked" } | { kind: "skipped"; result: string };

class ClaimLost extends Error {}

export async function runStep(config: Config, role: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const log = (message: string) => process.stderr.write(`socialv step ${role}: ${message}\n`);
  const taskId = env.BOARD_TASK;
  const epoch = Number(env.BOARD_TASK_EPOCH);
  const token = env.BOARD_TASK_TOKEN;
  if (!taskId || !Number.isInteger(epoch) || !token) {
    log("BOARD_TASK, BOARD_TASK_EPOCH and BOARD_TASK_TOKEN must be set: run me under `openboard tasks run`");
    return 2;
  }

  const me = connect(config, role);
  const held = me.tasks.held(taskId, { epoch, token });
  try {
    const view = await me.tasks.get(taskId);
    if (!holds(view.task, role, epoch)) {
      throw new ClaimLost();
    }
    const brief = parseBrief(view.task.text);
    if (brief.role !== role) {
      throw new Error(`this task is for role ${brief.role}, not ${role}`);
    }
    const def = getRole(role);
    if (!def) {
      throw new Error(`no role named ${role}`);
    }
    if (def.kind === "advisory") {
      throw new Error(`${role} is an advisory role: it answers mentions and works no tasks`);
    }
    if (!getSchema(brief.schema)) {
      throw new Error(`unknown output schema ${brief.schema}`);
    }
    const dir = runDir(config, brief.run);
    const out = inside(dir, brief.output);
    const step: StepContext = { config, role, taskId, epoch, env, me, brief, dir, out, root: view.task, replies: view.replies };

    const outcome =
      (await priorResult(step)) ?? (def.kind === "tool" ? await runTool(def, step) : await runAgent(def, step));
    if (outcome.kind === "blocked") {
      return 0;
    }
    const result = outcome.kind === "skipped" ? outcome.result : await writeOutput(step, outcome);
    await held.complete(result);
    return 0;
  } catch (error) {
    if (error instanceof ClaimLost || isClaimLost(error)) {
      log(`${taskId}: the claim is no longer ours; stopping without settling`);
      return 1;
    }
    const reason = error instanceof Error ? error.message : String(error);
    log(`${taskId}: failed: ${reason}`);
    try {
      await held.fail(reason.slice(0, 2000));
    } catch (settleError) {
      if (!isClaimLost(settleError)) {
        log(`${taskId}: could not fail the task: ${String(settleError)}`);
      }
    }
    return 1;
  }
}

interface StepContext {
  config: Config;
  role: string;
  taskId: string;
  epoch: number;
  env: NodeJS.ProcessEnv;
  me: Board;
  brief: Brief;
  /** The run folder. */
  dir: string;
  /** The output file, absolute. */
  out: string;
  root: Message;
  replies: Message[];
}

function holds(root: Message, role: string, epoch: number): boolean {
  const task = root.task;
  return task?.state === "claimed" && task.epoch === epoch && task.holder?.profile === role;
}

function isClaimLost(error: unknown): boolean {
  return error instanceof BoardError && error.code === "claim_lost";
}

// ----- Idempotency ---------------------------------------------------------

/** Where the step notes what it wrote for a task, so a second run need not redo it. */
function markerPath(step: StepContext): string {
  return path.join(step.dir, ".steps", `${step.taskId}.json`);
}

interface Marker {
  output: string;
  sha256: string;
  result: string;
}

/** A step may run twice for one task: if the first wrote the output, settle with it. */
async function priorResult(step: StepContext): Promise<Outcome | null> {
  const marker = await readIfExists(markerPath(step));
  const content = await readIfExists(step.out);
  if (!marker || content === null) {
    return null;
  }
  const noted = JSON.parse(marker) as Marker;
  return noted.output === step.brief.output && noted.sha256 === sha256(content)
    ? { kind: "skipped", result: noted.result }
    : null;
}

async function writeOutput(step: StepContext, outcome: { value: unknown; summary: string }): Promise<string> {
  const content = `${JSON.stringify(outcome.value, null, 2)}\n`;
  await writeAtomic(step.out, content);
  const digest = sha256(content);
  const summary = outcome.summary.split("\n", 1)[0]!.trim().slice(0, 200) || "done";
  const result = `${summary}\noutput: ${step.brief.output} sha256:${digest}`;
  const marker: Marker = { output: step.brief.output, sha256: digest, result };
  await writeAtomic(markerPath(step), JSON.stringify(marker));
  return result;
}

// ----- Tool roles ------------------------------------------------------------

async function runTool(def: ToolRole, step: StepContext): Promise<Outcome> {
  const { value, summary } = await def.run({
    config: step.config,
    brief: step.brief,
    taskId: step.taskId,
    runDir: step.dir,
    readInput: async (index = 0) => {
      const rel = step.brief.inputs[index];
      if (rel === undefined) {
        throw new Error(`the brief has no input ${index}`);
      }
      return readJson(inside(step.dir, rel));
    },
  });
  const checked = check(step.brief.schema, value);
  if (!checked.ok) {
    throw new Error(`output does not match ${step.brief.schema}:\n${checked.errors}`);
  }
  return { kind: "done", value: checked.value, summary };
}

// ----- Agent roles -----------------------------------------------------------

/**
 * Questions this role asked in the thread: its messages that mention someone
 * else. A reply from the owner resets the count, so that a task the step
 * handed to the owner can go on once they answer.
 */
export function countQuestions(replies: Message[], role: string, owner: string): number {
  let count = 0;
  for (const message of replies) {
    if (message.by.handle === owner) {
      count = 0;
    } else if (message.by.profile === role && (message.mentions ?? []).some((m) => m.profile !== role)) {
      count += 1;
    }
  }
  return count;
}

async function runAgent(def: AgentRole, step: StepContext): Promise<Outcome> {
  const { config, role, taskId, me } = step;
  const self = handleOf(config, role);

  const asked = countQuestions(step.replies, role, config.owner);
  if (asked > MAX_QUESTIONS) {
    const reason = `Question budget spent: ${asked} questions asked in this task. @${config.owner}, please answer in the thread or redirect the task.`;
    await me.reply(taskId, { text: reason, id: `${taskId}-budget-${step.epoch}` });
    await me.tasks.held(taskId, { epoch: step.epoch, token: step.env.BOARD_TASK_TOKEN! }).block(reason, { kind: "needs_input" });
    return { kind: "blocked" };
  }

  // The session is recorded on the task before it starts, so a later step resumes it.
  let sessionId = step.root.labels?.[SESSION_LABEL];
  let resume = sessionId !== undefined;
  if (!sessionId) {
    sessionId = randomUUID();
    try {
      await me.label(taskId, { set: { [SESSION_LABEL]: sessionId }, if: { [SESSION_LABEL]: null } });
    } catch (error) {
      if (!(error instanceof BoardError && error.code === "label_conflict")) {
        throw error;
      }
      sessionId = (await me.tasks.get(taskId)).task.labels?.[SESSION_LABEL] ?? sessionId;
      resume = true;
    }
  }

  const lastOwn = step.replies.map((m) => m.by.handle).lastIndexOf(self);
  const draftPath = `${step.out}.draft`;
  await rm(draftPath, { force: true });
  const ctx: AgentTaskContext = {
    kind: "task",
    config,
    brief: step.brief,
    role,
    taskId,
    runDir: step.dir,
    draftPath,
    schemaHint: getSchema(step.brief.schema)!.hint,
    replies: step.replies,
    questionsLeft: Math.max(0, MAX_QUESTIONS - asked),
    waitSecs: WAIT_SECS,
    resume: resume ? { replies: step.replies.slice(lastOwn + 1).filter((m) => m.by.handle !== self) } : undefined,
  };

  let result = await session(def, step, ctx, sessionId, resume);
  if (await blockedOrLost(step)) {
    return { kind: "blocked" };
  }
  let checked = await checkDraft(step, draftPath);
  if (!checked.ok) {
    // One more try in the same session, with the errors.
    result = await session(def, step, { ...ctx, resume: undefined, retry: { errors: checked.errors } }, result.sessionId, true);
    if (await blockedOrLost(step)) {
      return { kind: "blocked" };
    }
    checked = await checkDraft(step, draftPath);
    if (!checked.ok) {
      throw new Error(`the agent's output does not match ${step.brief.schema}:\n${checked.errors}`);
    }
  }
  await rm(draftPath, { force: true });
  return { kind: "done", value: checked.value, summary: result.text.trim().split("\n", 1)[0] ?? "" };
}

async function session(
  def: AgentRole,
  step: StepContext,
  ctx: AgentTaskContext,
  sessionId: string,
  resume: boolean,
): Promise<RunResult> {
  const runtime = selectRuntime(step.config);
  await mkdir(step.dir, { recursive: true });
  const base = {
    role: step.role,
    model: def.model,
    systemPrompt: def.systemPrompt(step.config),
    cwd: step.dir,
    env: sessionEnv(step.config, step.role, {
      ...step.env,
      BOARD_TASK: step.taskId,
      BOARD_TASK_EPOCH: String(step.epoch),
      BOARD_TASK_TOKEN: step.env.BOARD_TASK_TOKEN,
    }),
    context: ctx,
  };
  let result: RunResult;
  try {
    result = await runtime.run({ ...base, prompt: promptFor(def, ctx), ...(resume ? { resumeSessionId: sessionId } : { sessionId }) });
  } catch (error) {
    if (!(error instanceof SessionNotFoundError)) {
      throw error;
    }
    // Recorded but never started (the step was stopped first): start it now, with the full brief.
    const fresh = { ...ctx, resume: undefined };
    result = await runtime.run({ ...base, context: fresh, prompt: promptFor(def, fresh), sessionId });
  }
  await recordUsage(step.dir, { task: step.taskId, role: step.role, sessionId: result.sessionId, usage: result.usage });
  return result;
}

/** After a session: true if the agent blocked the task; throws if the claim was lost. */
async function blockedOrLost(step: StepContext): Promise<boolean> {
  const root = (await step.me.tasks.get(step.taskId)).task;
  if (root.task?.state === "blocked") {
    return true;
  }
  if (!holds(root, step.role, step.epoch)) {
    throw new ClaimLost();
  }
  return false;
}

async function checkDraft(step: StepContext, draftPath: string): Promise<ReturnType<typeof check>> {
  const text = await readIfExists(draftPath);
  if (text === null) {
    return { ok: false, errors: `no output was written to ${draftPath}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: `the output is not JSON: ${(error as Error).message}` };
  }
  return check(step.brief.schema, value);
}

/** Per-session usage, for the cost log (design 4.6). */
export async function recordUsage(
  dir: string,
  entry: { task?: string; thread?: string; role: string; sessionId: string; usage?: Usage },
): Promise<void> {
  await mkdir(path.join(dir, "sessions"), { recursive: true });
  await appendFile(path.join(dir, "sessions", "usage.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "openboardlol";
import { loadConfig, runDir, type Config } from "../../src/config.ts";
import { formatBrief, type BriefInput } from "../../src/schemas/brief.ts";
import { runStep } from "../../src/step/index.ts";
import type { TestBoard } from "../helpers/board.ts";

export function configOf(tb: TestBoard): Config {
  return loadConfig(tb.env);
}

/** Plays the conductor: a task kept for the brief's role. */
export async function createTask(tb: TestBoard, brief: Omit<BriefInput, "v">, summary = "A task"): Promise<Message> {
  const { task } = await tb.as("conductor").tasks.create(`production/${brief.run}`, {
    text: formatBrief(summary, { v: 1, ...brief }),
    for: brief.role,
  });
  return task;
}

export async function writeRunFile(tb: TestBoard, run: string, rel: string, value: unknown): Promise<void> {
  const file = path.join(runDir(configOf(tb), run), rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

/** Claims the task as `role`, as `tasks run` would, and runs one step on it. */
export async function claimAndStep(
  tb: TestBoard,
  role: string,
  taskId: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; epoch: number }> {
  const claim = await tb.as(role).tasks.claim(taskId);
  const env = {
    ...tb.env,
    ...extraEnv,
    BOARD_TASK: taskId,
    BOARD_TASK_EPOCH: String(claim.epoch),
    BOARD_TASK_TOKEN: claim.token,
  };
  const code = await runStep(loadConfig(env), role, env);
  return { code, epoch: claim.epoch };
}

export async function taskOf(tb: TestBoard, id: string) {
  return (await tb.as("conductor").tasks.get(id)).task;
}

/** Polls until `check` holds, or fails after `ms`. */
export async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

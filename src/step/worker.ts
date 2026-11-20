// `socialv worker --role <role>`: a loop around Openboard's own runner,
// `openboard tasks run`. It holds no claim logic: it restarts the runner,
// backs off when the board is away, and logs one line per task.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import { GATEWAY } from "../channels.ts";
import { withoutProviderKeys } from "../gateway/keys.ts";
import { getRole } from "../workers/registry.ts";

export interface WorkerOptions {
  signal?: AbortSignal;
  /** The step command, before the role. Default: this checkout's `bin/socialv step`. */
  command?: string[];
}

/** Error codes from `tasks run` that only mean the board is not there yet. */
const UNREACHABLE = new Set(["connection_failed", "not_found", "lease_unconfirmed"]);

export async function runWorker(config: Config, role: string, opts: WorkerOptions = {}): Promise<void> {
  const def = getRole(role);
  if (!def || def.kind === "advisory") {
    throw new Error(`${role} is not a role with a task queue`);
  }
  const { signal } = opts;
  const command = opts.command ?? [fileURLToPath(new URL("../../bin/socialv", import.meta.url)), "step"];
  const log = (message: string) => process.stderr.write(`socialv worker ${role}: ${message}\n`);
  let backoff = 0;

  while (!signal?.aborted) {
    const started = Date.now();
    const { code, error, task, state } = await runOnce(config, role, def.channel ?? "production/", [...command, role], signal);
    if (signal?.aborted) {
      break;
    }
    if (task) {
      log(`task ${task}: ${state ?? "ended"} (exit ${code})`);
    }
    if (error && UNREACHABLE.has(error)) {
      backoff = Math.min(Math.max(backoff * 2, 2000), 30_000);
      log(`board unreachable (${error}); retrying in ${backoff / 1000}s`);
      await sleep(backoff, signal);
      continue;
    }
    backoff = 0;
    if (error && error !== "timeout" && error !== "nothing_ready" && !task) {
      log(`tasks run failed (${error})`);
    }
    // Never spin: a run that failed at once waits a moment before the next.
    if (code !== 0 && Date.now() - started < 1000) {
      await sleep(1000, signal);
    }
  }
}

interface RunOutcome {
  code: number | null;
  /** The error code `tasks run` printed, if any. */
  error?: string;
  task?: string;
  /** The task's state when the command exited, as `tasks run` reported it. */
  state?: string;
}

/**
 * The environment of a worker's `tasks run` child, and so of its steps.
 * Only the gateway keeps provider keys (requirement G1).
 */
export function workerEnv(config: Config, role: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(role === GATEWAY ? base : withoutProviderKeys(base)),
    BOARD_URL: config.boardUrl,
    BOARD_NAME: config.boardName,
    SOCIALV_PROJECT_DIR: config.projectDir,
    SOCIALV_OWNER: config.owner,
    SOCIALV_REVIEW_URL: config.reviewUrl,
    SOCIALV_RUNTIME: config.runtime,
  };
  delete env.BOARD_AS;
  delete env.BOARD_PROFILE;
  delete env.BOARD_TASK;
  delete env.BOARD_TASK_EPOCH;
  delete env.BOARD_TASK_TOKEN;
  return env;
}

function runOnce(config: Config, role: string, channel: string, command: string[], signal?: AbortSignal): Promise<RunOutcome> {
  const env = workerEnv(config, role);
  return new Promise((resolve) => {
    const outcome: RunOutcome = { code: null };
    const child = spawn("openboard", ["--as", role, "tasks", "run", "--ready", channel, "--wait", "9m", "--", ...command], {
      env,
      stdio: ["ignore", "inherit", "pipe"],
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      let match: RegExpExecArray | null;
      if ((match = /^openboard: claimed task (\S+)/.exec(line))) {
        outcome.task = match[1];
      } else if ((match = /^openboard: .*task (\S+) is (\w+)/.exec(line))) {
        outcome.task = match[1];
        outcome.state = match[2];
      } else if ((match = /^openboard: error \((\w+)\)/.exec(line))) {
        outcome.error = match[1];
        if (outcome.task) {
          process.stderr.write(`${line}\n`);
        }
      } else if (!line.startsWith("next:") && !line.startsWith("openboard: ")) {
        // The step's own output.
        process.stderr.write(`${line}\n`);
      }
    });
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ code: null, error: (error as NodeJS.ErrnoException).code ?? "spawn_failed" });
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ ...outcome, code });
    });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

// `socialv up`: everything for local development in one terminal. A local
// board (if none answers), the review server, a worker per role and the
// conductor for one run, each as its own child process.

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { boardAnswers as boardAnswersAs } from "./board/connect.ts";
import { gatesChannel } from "./channels.ts";
import { runDir, type Config } from "./config.ts";
import { listRoles, type RoleInfo } from "./workers/registry.ts";

// ---------------------------------------------------------------- supervisor

export interface ProcessSpec {
  /** Shown before each line of the process's output. */
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Restart it, with backoff, when it exits without being asked to. */
  restart: boolean;
}

export interface SupervisorOptions {
  /** Where prefixed output goes. Defaults to process.stdout. */
  out?: (line: string) => void;
  /** First restart delay in ms; doubles on each quick failure. */
  backoffMs?: number;
  /** Longest restart delay in ms. */
  maxBackoffMs?: number;
  /** A process that ran at least this long has its backoff reset. */
  healthyMs?: number;
  /** How long to wait after SIGTERM before SIGKILL, in ms. */
  stopGraceMs?: number;
}

export interface Supervised {
  readonly name: string;
  /** Resolves with the exit code of the process (signals map to 128+n) once it exits and will not be restarted. */
  readonly done: Promise<number>;
  readonly restarts: number;
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

/**
 * Runs child processes with prefixed output, restarts the ones that should
 * stay up, and stops them all on request. Each child gets its own process
 * group so that stopping it also stops whatever it started.
 */
export class Supervisor {
  #out: (line: string) => void;
  #backoffMs: number;
  #maxBackoffMs: number;
  #healthyMs: number;
  #stopGraceMs: number;
  #stopping = false;
  #entries = new Set<{ child?: ChildProcess; timer?: NodeJS.Timeout; stop(): void }>();
  #width = 0;

  constructor(opts: SupervisorOptions = {}) {
    this.#out = opts.out ?? ((line) => process.stdout.write(line + "\n"));
    this.#backoffMs = opts.backoffMs ?? 1000;
    this.#maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.#healthyMs = opts.healthyMs ?? 60_000;
    this.#stopGraceMs = opts.stopGraceMs ?? 5000;
  }

  /** Widens the name column to fit these names, so output lines up from the start. */
  align(names: string[]): void {
    for (const name of names) this.#width = Math.max(this.#width, name.length);
  }

  /** Writes a line under a name, aligned with the children's output. */
  log(name: string, line: string): void {
    this.#width = Math.max(this.#width, name.length);
    this.#out(`${name.padEnd(this.#width)} | ${line}`);
  }

  start(spec: ProcessSpec): Supervised {
    this.#width = Math.max(this.#width, spec.name.length);
    let restarts = 0;
    let delay = this.#backoffMs;
    let resolveDone!: (code: number) => void;
    const done = new Promise<number>((resolve) => (resolveDone = resolve));
    const entry: { child?: ChildProcess; timer?: NodeJS.Timeout; stop(): void } = {
      stop: () => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = undefined;
        if (!entry.child) resolveDone(143);
      },
    };
    this.#entries.add(entry);

    const launch = () => {
      entry.timer = undefined;
      const started = Date.now();
      const child = spawn(spec.command, spec.args, {
        env: spec.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      entry.child = child;
      for (const stream of [child.stdout!, child.stderr!]) {
        createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) => this.log(spec.name, line));
      }
      let failedToSpawn = false;
      child.on("error", (error) => {
        failedToSpawn = true;
        this.log(spec.name, `could not start: ${error.message}`);
      });
      child.on("close", (code, signal) => {
        entry.child = undefined;
        const status = code ?? 128 + (SIGNAL_NUMBERS[signal ?? ""] ?? 15);
        if (this.#stopping || !spec.restart || failedToSpawn) {
          if (!this.#stopping) this.log(spec.name, `exited with ${signal ?? `code ${code}`}`);
          this.#entries.delete(entry);
          resolveDone(failedToSpawn ? 127 : status);
          return;
        }
        if (Date.now() - started >= this.#healthyMs) delay = this.#backoffMs;
        this.log(spec.name, `exited unexpectedly with ${signal ?? `code ${code}`}; restarting in ${delay} ms`);
        entry.timer = setTimeout(() => {
          restarts++;
          launch();
        }, delay);
        delay = Math.min(delay * 2, this.#maxBackoffMs);
      });
    };
    launch();

    return {
      name: spec.name,
      done,
      get restarts() {
        return restarts;
      },
    };
  }

  /** Stops every child: SIGTERM to its process group, then SIGKILL after the grace period. */
  async stopAll(): Promise<void> {
    this.#stopping = true;
    const waits: Promise<void>[] = [];
    for (const entry of this.#entries) {
      entry.stop();
      const child = entry.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) continue;
      waits.push(
        new Promise<void>((resolve) => {
          const kill = setTimeout(() => signalGroup(child, "SIGKILL"), this.#stopGraceMs);
          child.once("close", () => {
            clearTimeout(kill);
            resolve();
          });
          signalGroup(child, "SIGTERM");
        }),
      );
    }
    await Promise.all(waits);
    this.#entries.clear();
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

// ---------------------------------------------------------------- up

export interface UpOptions {
  run: string;
  /** Passed to the conductor: the pipeline's name. Default: the conductor's default, or what run.json recorded. */
  pipeline?: string;
  /** Passed to the conductor: the reference video, for the analysis pipeline. */
  source?: string;
  /** Passed to the conductor: the render plan's name, for the render pipeline. */
  plan?: string;
  signal?: AbortSignal;
  /** The socialv launcher to run children with. Defaults to this checkout's bin/socialv. */
  bin?: string;
  /** Roles to start. Defaults to listRoles(). */
  roles?: RoleInfo[];
  /** The board launcher. Defaults to `openboard`. */
  openboard?: string;
  supervisor?: SupervisorOptions;
}

/** Environment that makes a child load the same Config. */
export function configEnv(config: Config): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BOARD_URL: config.boardUrl,
    BOARD_NAME: config.boardName,
    SOCIALV_OWNER: config.owner,
    SOCIALV_PROJECT_DIR: config.projectDir,
    SOCIALV_REVIEW_URL: config.reviewUrl,
    SOCIALV_RUNTIME: config.runtime,
  };
}

/** True when an Openboard server answers at `url`. */
export async function boardAnswers(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(new URL("/v1/health", url), { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Runs everything for one run until the conductor finishes, and returns the
 * conductor's exit code; 130 or 143 when stopped by a signal first.
 */
export async function runUp(config: Config, opts: UpOptions): Promise<number> {
  const bin = opts.bin ?? path.resolve(import.meta.dirname, "..", "bin", "socialv");
  const roles = opts.roles ?? listRoles();
  const env = configEnv(config);
  const sup = new Supervisor(opts.supervisor);
  sup.align(["up", "board", "review", "conductor", ...roles.map((r) => r.name)]);
  const signalCode = () => (opts.signal?.reason === "SIGINT" ? 130 : 143);

  let aborted = opts.signal?.aborted ?? false;
  const onAbort = new Promise<"aborted">((resolve) => {
    if (aborted) resolve("aborted");
    opts.signal?.addEventListener(
      "abort",
      () => {
        aborted = true;
        resolve("aborted");
      },
      { once: true },
    );
  });

  try {
    // The board: use one that answers; otherwise start a local one, which we own.
    // A network board needs our login to answer; a local one has a plain health route.
    const answers = config.boardUrl.startsWith("https://")
      ? await boardAnswersAs(config)
      : await boardAnswers(config.boardUrl);
    if (answers) {
      sup.log("up", `using the board already running at ${config.boardUrl}`);
    } else {
      const url = new URL(config.boardUrl);
      if (!LOOPBACK.has(url.hostname)) {
        throw new Error(`no board answers at ${config.boardUrl}, and it is not a loopback address to start one on`);
      }
      const port = url.port || "80";
      const dataDir = path.join(config.projectDir, ".board");
      sup.log("up", `starting a local board on port ${port} (data in ${dataDir})`);
      const board = sup.start({
        name: "board",
        command: opts.openboard ?? "openboard",
        args: ["serve", "--data-dir", dataDir, "--port", port],
        env,
        restart: true,
      });
      const giveUp = new AbortController();
      const ready = await Promise.race([
        waitForBoard(config.boardUrl, 15_000, giveUp.signal),
        board.done.then(() => false),
        onAbort.then(() => false),
      ]);
      giveUp.abort();
      if (aborted) return signalCode();
      if (!ready) throw new Error(`the board did not answer at ${config.boardUrl}`);
    }

    sup.start({ name: "review", command: bin, args: ["review"], env, restart: true });
    for (const role of roles) {
      const command = role.kind === "advisory" ? "mentions" : "worker";
      sup.start({ name: role.name, command: bin, args: [command, "--role", role.name], env, restart: true });
    }
    const conductor = sup.start({ name: "conductor", command: bin, args: conductorArgs(opts), env, restart: false });

    // The web page keeps its route in the query string. Openboard does not document this yet (openboard#6).
    const gatesLink = new URL(config.boardUrl);
    gatesLink.search = new URLSearchParams({ board: config.boardName, channel: gatesChannel(opts.run) }).toString();
    const reviewRun = new URL(`/runs/${encodeURIComponent(opts.run)}/`, config.reviewUrl).toString();
    for (const line of [
      `board:  ${config.boardUrl}  (board "${config.boardName}")`,
      `review: ${reviewRun}`,
      `gates:  ${gatesLink}`,
      `Open the gates link (channel ${gatesChannel(opts.run)}) and reply in a gate's thread`,
      `to decide: approve | approve 1,3 | revise: <notes> | reject: <reason>.  Ctrl-C stops everything.`,
    ]) {
      sup.log("up", line);
    }

    const outcome = await Promise.race([conductor.done, onAbort]);
    if (outcome === "aborted") {
      sup.log("up", "stopping");
      return signalCode();
    }
    // The run is over, so `up` has nothing left to do: say so plainly before it exits.
    const result = outcome === 0 ? "completed" : outcome === 3 ? "was rejected at a gate" : `failed (conductor exit code ${outcome})`;
    sup.log("up", `run ${opts.run} ${result}.`);
    sup.log("up", `its files are in ${runDir(config, opts.run)}`);
    sup.log("up", "stopping the workers and the review server; the board's threads keep the record.");
    return outcome;
  } finally {
    await sup.stopAll();
  }
}

/** The conductor's command line: the run, and the pipeline options given to `up`. */
export function conductorArgs(opts: Pick<UpOptions, "run" | "pipeline" | "source" | "plan">): string[] {
  const args = ["conductor", "--run", opts.run];
  if (opts.pipeline !== undefined) args.push("--pipeline", opts.pipeline);
  if (opts.source !== undefined) args.push("--source", opts.source);
  if (opts.plan !== undefined) args.push("--plan", opts.plan);
  return args;
}

async function waitForBoard(url: string, timeoutMs: number, stop: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stop.aborted) {
    if (await boardAnswers(url, 500)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

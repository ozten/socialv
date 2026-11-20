// The socialv command. Each subcommand loads the config and calls one entry
// point. Entry points are imported only when their command runs, so that
// `socialv step` (started by `openboard tasks run` for every task) starts fast.

import { parseArgs, type ParseArgsConfig } from "node:util";
import { loadConfig, type Config } from "./config.ts";

const USAGE = `socialv: agents that produce social videos, coordinated over Openboard

Usage: socialv <command> [options]

Commands:
  up --run <id>           Start everything for local development: a board if none
                          is running, the review server, every worker and the conductor
  conductor --run <id>    Run a pipeline for one run (exit 0 completed, 3 rejected)
  step <role>             Work the task in BOARD_TASK as <role> (run by \`openboard tasks run\`)
  worker --role <role>    Claim and work tasks for a tool or agent role, forever
  mentions --role <role>  Answer mentions for an advisory role, forever
  review [--port N]       Serve review pages and run files on 127.0.0.1

Run \`socialv <command> --help\` for a command's options.
Settings come from the environment: BOARD_URL, BOARD_NAME, SOCIALV_PROJECT_DIR,
SOCIALV_OWNER, SOCIALV_REVIEW_URL, SOCIALV_RUNTIME.
`;

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | undefined>;

interface Command {
  usage: string;
  options: Options;
  positionals: number;
  /** Returns the exit code. `signal` aborts on SIGINT or SIGTERM, when `handlesSignals`. */
  run(config: Config, values: Values, positionals: string[], signal: AbortSignal): Promise<number>;
  handlesSignals: boolean;
}

/** 130 for SIGINT, 143 for SIGTERM. */
const signalExit = (signal: AbortSignal) => (signal.reason === "SIGINT" ? 130 : 143);
const help = { help: { type: "boolean", short: "h" } } as const satisfies Options;
const pipelineOptions = {
  run: { type: "string" },
  pipeline: { type: "string" },
  source: { type: "string" },
} as const satisfies Options;

const COMMANDS: Record<string, Command> = {
  up: {
    usage: `Usage: socialv up --run <id> [--pipeline <name>] [--source <path>]

Starts a local board at BOARD_URL if none answers there (data in
<project>/.board; an already-running board is left alone), the review server,
a worker for every tool and agent role, a mention loop for every advisory role,
and the conductor for the run. Each runs as a child process with its output
prefixed; workers that exit are restarted. Ctrl-C stops everything.
Exits with the conductor's code. --pipeline and --source are passed to the
conductor; see \`socialv conductor --help\`.
`,
    options: { ...help, ...pipelineOptions },
    positionals: 0,
    handlesSignals: true,
    async run(config, values, _p, signal) {
      const run = required(values, "run");
      const { runUp } = await import("./up.ts");
      return runUp(config, { run, pipeline: optional(values, "pipeline"), source: optional(values, "source"), signal });
    },
  },
  conductor: {
    usage: `Usage: socialv conductor --run <id> [--pipeline <name>] [--source <path>]

Runs a pipeline for one run. The first start records the pipeline and its
parameters in <project>/runs/<id>/run.json; a restart reads them from there,
needs neither flag, and refuses a different pipeline or source.

  --pipeline <name>   demo (the default) or analysis
  --source <path>     analysis only: the reference video, relative to the
                      project folder. Default: \`source\` in the project's
                      socialv.json, else source/original.mov

Exit codes: 0 completed, 3 rejected, 130/143 stopped by SIGINT/SIGTERM.
`,
    options: { ...help, ...pipelineOptions },
    positionals: 0,
    handlesSignals: true,
    async run(config, values, _p, signal) {
      const run = required(values, "run");
      const { runConductor } = await import("./conductor/index.ts");
      const outcome = await runConductor(config, {
        run,
        pipeline: optional(values, "pipeline"),
        params: { source: optional(values, "source") },
        signal,
      });
      if (outcome === "completed") return 0;
      if (outcome === "rejected") return 3;
      return signal.aborted ? signalExit(signal) : 1;
    },
  },
  step: {
    usage: `Usage: socialv step <role>

Works the task named by BOARD_TASK as <role> and exits with its status.
Started by \`openboard tasks run\`; not usually run by hand.
`,
    options: { ...help },
    positionals: 1,
    handlesSignals: false,
    async run(config, _v, positionals) {
      const { runStep } = await import("./step/index.ts");
      return runStep(config, positionals[0]!, process.env);
    },
  },
  worker: {
    usage: `Usage: socialv worker --role <role>

Claims and works tasks for one tool or agent role until stopped.
`,
    options: { ...help, role: { type: "string" } },
    positionals: 0,
    handlesSignals: true,
    async run(config, values, _p, signal) {
      const role = required(values, "role");
      const { runWorker } = await import("./step/index.ts");
      await runWorker(config, role, { signal });
      return signal.aborted ? signalExit(signal) : 0;
    },
  },
  mentions: {
    usage: `Usage: socialv mentions --role <role>

Answers mentions of one advisory role until stopped.
`,
    options: { ...help, role: { type: "string" } },
    positionals: 0,
    handlesSignals: true,
    async run(config, values, _p, signal) {
      const role = required(values, "role");
      const { runMentions } = await import("./step/index.ts");
      await runMentions(config, role, { signal });
      return signal.aborted ? signalExit(signal) : 0;
    },
  },
  review: {
    usage: `Usage: socialv review [--port N]

Serves gate pages and run files from <project>/runs on 127.0.0.1. The port
defaults to the one in SOCIALV_REVIEW_URL; 0 picks a free one.
`,
    options: { ...help, port: { type: "string" } },
    positionals: 0,
    handlesSignals: true,
    async run(config, values, _p, signal) {
      let port: number | undefined;
      if (values.port !== undefined) {
        port = Number(values.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be a port number`);
      }
      const { runReview } = await import("./review/index.ts");
      const server = await runReview(config, { port, signal });
      process.stdout.write(`review server at ${server.url}/\n`);
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await server.close();
      return signalExit(signal);
    },
  },
};

class UsageError extends Error {}

function optional(values: Values, name: string): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new UsageError(`--${name} needs a value`);
  return value;
}

function required(values: Values, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value === "") throw new UsageError(`--${name} is required`);
  return value;
}

/** Runs the CLI and returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    const topic = name === "help" ? rest[0] : undefined;
    if (topic !== undefined) {
      const command = COMMANDS[topic];
      if (!command) return unknown(topic);
      process.stdout.write(command.usage);
      return 0;
    }
    (name === undefined ? process.stderr : process.stdout).write(USAGE);
    return name === undefined ? 2 : 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) return unknown(name);

  let values: Values;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: rest, options: command.options, allowPositionals: true, strict: true });
    values = parsed.values as Values;
    positionals = parsed.positionals;
    if (values.help) {
      process.stdout.write(command.usage);
      return 0;
    }
    if (positionals.length !== command.positionals) {
      throw new UsageError(
        command.positionals ? `expected ${command.positionals} argument(s)` : `unexpected argument: ${positionals[0]}`,
      );
    }
  } catch (error) {
    process.stderr.write(`socialv ${name}: ${(error as Error).message}\n\n${command.usage}`);
    return 2;
  }

  const controller = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    if (controller.signal.aborted) process.exit(sig === "SIGINT" ? 130 : 143);
    controller.abort(sig);
  };
  if (command.handlesSignals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  try {
    const config = loadConfig();
    return await command.run(config, values, positionals, controller.signal);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`socialv ${name}: ${error.message}\n\n${command.usage}`);
      return 2;
    }
    if (controller.signal.aborted) return signalExit(controller.signal);
    process.stderr.write(`socialv ${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function unknown(name: string): number {
  process.stderr.write(`socialv: unknown command "${name}"\n\n${USAGE}`);
  return 2;
}

const isMain = process.argv[1] !== undefined && import.meta.filename === (await realpathOrSelf(process.argv[1]));

async function realpathOrSelf(file: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  try {
    return await realpath(file);
  } catch {
    return file;
  }
}

if (isMain) {
  const code = await main(process.argv.slice(2));
  // Let stdout and stderr drain, then exit even if something left a handle open.
  process.exitCode = code;
  await Promise.all([process.stdout, process.stderr].map((s) => new Promise((resolve) => s.write("", resolve))));
  process.exit(code);
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { connect } from "../board/connect.ts";
import { CONDUCTOR } from "../channels.ts";
import { runDir, type Config } from "../config.ts";
import { RunDriver } from "./engine.ts";
import { DEFAULT_PIPELINE, getPipeline, type Params } from "./pipelines/index.ts";

export type { Pipeline } from "./pipeline.ts";

/** What `runs/<run>/run.json` records: the pipeline a run was started with, and its parameters. */
export interface RunFile {
  pipeline: string;
  params: Params;
  started_at: string;
}

/**
 * Drives one run on the board, as profile `conductor`, until it completes,
 * is rejected at a gate, or `signal` aborts. Creates the run's tasks if they
 * do not exist yet. Safe to kill and start again at any point.
 *
 * The first start records the pipeline and its parameters in
 * `runs/<run>/run.json`; a restart reads them back, and refuses a different
 * pipeline or different parameters.
 */
export async function runConductor(
  config: Config,
  opts: {
    run: string;
    signal?: AbortSignal;
    /** The pipeline's name: `demo` (the default) or `analysis`. */
    pipeline?: string;
    /** The pipeline's parameters, such as `source` for `analysis`. Undefined values are ignored. */
    params?: Params;
    /** Where progress lines go. Default: stderr. */
    log?: (line: string) => void;
  },
): Promise<"completed" | "rejected" | "aborted"> {
  const { pipeline, params } = await runFile(config, opts.run, opts.pipeline, opts.params ?? {});
  const handle = connect(config, CONDUCTOR);
  const driver = new RunDriver(config, opts.run, getPipeline(pipeline).build(params), handle, { log: opts.log });
  return driver.drive(opts.signal);
}

/** Reads `run.json`, checking it against what was asked for, or writes it on the first start. */
export async function runFile(config: Config, run: string, pipeline: string | undefined, given: Params): Promise<RunFile> {
  const file = path.join(runDir(config, run), "run.json");
  const asked = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
  let saved: RunFile | null = null;
  try {
    saved = JSON.parse(await readFile(file, "utf8")) as RunFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read ${file}: ${(error as Error).message}`);
  }
  if (saved) {
    if (pipeline !== undefined && pipeline !== saved.pipeline) {
      throw new Error(`run ${run} was started with pipeline ${saved.pipeline}, not ${pipeline} (see ${file})`);
    }
    for (const [key, value] of Object.entries(asked)) {
      if (JSON.stringify(saved.params[key]) !== JSON.stringify(value)) {
        throw new Error(`run ${run} was started with ${key}=${JSON.stringify(saved.params[key])}, not ${JSON.stringify(value)} (see ${file})`);
      }
    }
    getPipeline(saved.pipeline);
    return saved;
  }
  const name = pipeline ?? DEFAULT_PIPELINE;
  const record: RunFile = {
    pipeline: name,
    params: await getPipeline(name).resolve(config, asked),
    started_at: new Date().toISOString(),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
  return record;
}

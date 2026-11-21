import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { connect } from "../board/connect.ts";
import { CONDUCTOR } from "../channels.ts";
import { runDir, type Config } from "../config.ts";
import { RunDriver } from "./engine.ts";
import { DEFAULT_PIPELINE, getPipeline, type Params } from "./pipelines/index.ts";

export type { Pipeline } from "./pipeline.ts";

/** One pipeline started on a run, with its parameters. */
export interface Job {
  pipeline: string;
  params: Params;
  started_at: string;
}

/**
 * What `runs/<run>/run.json` records: the pipeline a run was started with,
 * and any jobs started on it afterwards (a render of an analysed video, say).
 */
export interface RunFile extends Job {
  jobs?: Job[];
}

/**
 * Drives one run on the board, as profile `conductor`, until it completes,
 * is rejected at a gate, or `signal` aborts. Creates the run's tasks if they
 * do not exist yet. Safe to kill and start again at any point.
 *
 * The first start records the pipeline and its parameters in
 * `runs/<run>/run.json`; a restart reads them back. Naming another pipeline
 * starts a further job on the same run.
 */
export async function runConductor(
  config: Config,
  opts: {
    run: string;
    signal?: AbortSignal;
    /** The pipeline's name: `demo` (the default), `analysis` or `render`. Unnamed: the run's latest job. */
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

/**
 * The job to drive, from `run.json`. With no pipeline named, the latest job.
 * A job is found again by its pipeline and the parameters asked for; a
 * pipeline that is not repeatable has one job per run and refuses different
 * parameters. Otherwise a new job is recorded.
 */
export async function runFile(config: Config, run: string, pipeline: string | undefined, given: Params): Promise<Job> {
  const file = path.join(runDir(config, run), "run.json");
  const asked = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
  let saved: RunFile | null = null;
  try {
    saved = JSON.parse(await readFile(file, "utf8")) as RunFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read ${file}: ${(error as Error).message}`);
  }
  const jobs: Job[] = saved ? [saved, ...(saved.jobs ?? [])] : [];
  const differs = (job: Job) => Object.entries(asked).find(([key, value]) => JSON.stringify(job.params[key]) !== JSON.stringify(value));

  const name = pipeline ?? jobs.at(-1)?.pipeline ?? DEFAULT_PIPELINE;
  const def = getPipeline(name);
  const same = jobs.filter((job) => job.pipeline === name);
  const found = same.findLast((job) => !differs(job));
  if (found) return found;
  const last = same.at(-1);
  if (last && !def.repeatable) {
    const [key, value] = differs(last)!;
    throw new Error(`run ${run} was started with ${key}=${JSON.stringify(last.params[key])}, not ${JSON.stringify(value)} (see ${file})`);
  }

  const job: Job = { pipeline: name, params: await def.resolve(config, asked, run), started_at: new Date().toISOString() };
  const record: RunFile = saved ? { ...saved, jobs: [...(saved.jobs ?? []), job] } : job;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
  return job;
}

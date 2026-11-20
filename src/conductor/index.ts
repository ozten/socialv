import { board } from "openboardlol";
import { CONDUCTOR } from "../channels.ts";
import type { Config } from "../config.ts";
import { RunDriver } from "./engine.ts";
import type { Pipeline } from "./pipeline.ts";
import { demoPipeline } from "./pipelines/demo.ts";

export type { Pipeline } from "./pipeline.ts";

/**
 * Drives one run on the board, as profile `conductor`, until it completes,
 * is rejected at a gate, or `signal` aborts. Creates the run's tasks if they
 * do not exist yet. Safe to kill and start again at any point.
 */
export async function runConductor(
  config: Config,
  opts: {
    run: string;
    signal?: AbortSignal;
    /** The pipeline to run. Default: the M0 demo. */
    pipeline?: Pipeline;
    /** Where progress lines go. Default: stderr. */
    log?: (line: string) => void;
  },
): Promise<"completed" | "rejected" | "aborted"> {
  const handle = board({ url: config.boardUrl, name: config.boardName, profile: CONDUCTOR });
  const driver = new RunDriver(config, opts.run, opts.pipeline ?? demoPipeline(), handle, { log: opts.log });
  return driver.drive(opts.signal);
}

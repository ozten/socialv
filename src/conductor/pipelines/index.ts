// The pipelines a run can use, by name, and the parameters each takes.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../../config.ts";
import type { Pipeline } from "../pipeline.ts";
import { analysisPipeline, DEFAULT_SOURCE } from "./analysis.ts";
import { RenderPlan } from "../../schemas/render.ts";
import { runDir } from "../../config.ts";
import { demoPipeline } from "./demo.ts";
import { planPath, renderPipeline, type RenderTake } from "./render.ts";

export type Params = Record<string, unknown>;

interface PipelineDef {
  /** Fills in defaults and checks what was given. Runs once, when a job starts; the result is kept in run.json. */
  resolve(config: Config, given: Params, run: string): Promise<Params>;
  /** True when a run may have several jobs of this pipeline, told apart by their parameters. */
  repeatable?: boolean;
  build(params: Params): Pipeline;
}

const PIPELINES: Record<string, PipelineDef> = {
  demo: {
    async resolve(_config, given) {
      only("demo", given, ["topic"]);
      return given.topic === undefined ? {} : { topic: str("topic", given.topic) };
    },
    build: (params) => demoPipeline(params.topic as string | undefined),
  },
  analysis: {
    async resolve(config, given) {
      only("analysis", given, ["source"]);
      const source = given.source === undefined ? ((await projectSource(config)) ?? DEFAULT_SOURCE) : str("source", given.source);
      if (path.isAbsolute(source) || source.split(/[\\/]/).includes("..")) {
        throw new Error(`source must be a path inside the project folder, relative to it: ${source}`);
      }
      return { source };
    },
    build: (params) => analysisPipeline(params.source as string),
  },
  render: {
    repeatable: true,
    async resolve(config, given, run) {
      only("render", given, ["plan"]);
      const name = str("plan", given.plan);
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) throw new Error(`plan must be a short lower-case name, not ${JSON.stringify(name)}`);
      const file = path.join(runDir(config, run), planPath(name));
      let plan: RenderPlan;
      try {
        plan = RenderPlan.parse(JSON.parse(await readFile(file, "utf8")));
      } catch (error) {
        throw new Error(`cannot use the render plan ${file}: ${(error as Error).message}`);
      }
      if (plan.name !== name) throw new Error(`${file} names itself ${plan.name}, not ${name}`);
      // The takes are fixed when the job starts; their prompts and files can still change before approval.
      return { plan: name, takes: plan.takes.map(({ id, shot, label }) => ({ id, shot, label })) };
    },
    build: (params) => renderPipeline(params.plan as string, params.takes as RenderTake[]),
  },
};

export const DEFAULT_PIPELINE = "demo";

export function pipelineNames(): string[] {
  return Object.keys(PIPELINES);
}

export function getPipeline(name: string): PipelineDef {
  const def = Object.hasOwn(PIPELINES, name) ? PIPELINES[name] : undefined;
  if (!def) throw new Error(`no pipeline named ${name}; known: ${pipelineNames().join(", ")}`);
  return def;
}

function only(pipeline: string, given: Params, allowed: string[]): void {
  for (const key of Object.keys(given)) {
    if (given[key] !== undefined && !allowed.includes(key)) {
      throw new Error(`pipeline ${pipeline} takes no parameter ${key}`);
    }
  }
}

function str(name: string, value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

/** The `source` field of the project's socialv.json, if any. */
async function projectSource(config: Config): Promise<string | undefined> {
  try {
    const file = JSON.parse(await readFile(path.join(config.projectDir, "socialv.json"), "utf8")) as { source?: unknown };
    return typeof file.source === "string" && file.source !== "" ? file.source : undefined;
  } catch {
    return undefined;
  }
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GateItem } from "../review/types.ts";

/** What a pipeline's functions may look at. */
export interface RunContext {
  run: string;
  /** Absolute path of the run folder. */
  runDir: string;
}

/** One task of a fanned-out stage, from the data an earlier stage wrote. */
export interface FanItem {
  /** The shot this task is about: its `shot` label and `brief.shot`. Unique in the stage. */
  shot: string;
  summary: string;
  inputs: string[];
  output: string;
}

/**
 * A stage that becomes one task per item. Its tasks are created once every
 * stage it needs has completed, from what `items` reads in the run folder.
 */
export interface FanOut {
  items(ctx: RunContext): Promise<FanItem[]>;
}

/** Where a stage's tasks live: `work/<run>`, or `spend/<run>` for paid calls the gateway claims. */
export type ChannelKind = "work" | "spend";

/**
 * A unit of work done by a role: one board task per revision, or, with
 * `fanOut`, one task per item per revision.
 */
export interface StageNode {
  kind: "stage";
  name: string;
  role: string;
  /** Names of nodes whose tasks must complete first. A gate here means "only after approval". */
  needs: string[];
  /** The one-line summary that starts the task's text. */
  summary: string;
  inputs: string[];
  output: string;
  schema: string;
  params: Record<string, unknown>;
  /** Default `work`. */
  channel?: ChannelKind;
  /** Set for a stage that expands into one task per item. `inputs`, `output` and `summary` are then per item. */
  fanOut?: FanOut;
}

/** An approval by the owner: a task in the gates channel kept for the conductor. */
export interface GateNode {
  kind: "gate";
  name: string;
  /** The stages whose output is reviewed. The gate opens when they complete. */
  needs: string[];
  title: string;
  summary: string;
  /** Stages redone, with the owner's notes, on `revise`. */
  rework: string[];
  /** The numbered items shown in the packet and on the review page. */
  items(ctx: RunContext, stages: StageNode[]): Promise<GateItem[]>;
}

export type PipelineNode = StageNode | GateNode;

/**
 * A pipeline is its nodes, in an order where every node comes after what it
 * needs. A node's tasks are created as soon as everything it needs exists,
 * except that a node needing a gate waits for the gate to be approved
 * (staged expansion).
 */
export interface Pipeline {
  name: string;
  nodes: PipelineNode[];
}

/** Gate items from the reviewed stages' output files: one item per stage, showing `text` when the file has it. */
export async function outputItems(ctx: RunContext, stages: StageNode[]): Promise<GateItem[]> {
  const items: GateItem[] = [];
  for (const [index, stage] of stages.entries()) {
    let text: string;
    try {
      const raw = await readFile(path.join(ctx.runDir, stage.output), "utf8");
      const parsed: unknown = JSON.parse(raw);
      text =
        parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string"
          ? (parsed as { text: string }).text
          : raw;
    } catch (error) {
      text = `(cannot read ${stage.output}: ${(error as Error).message})`;
    }
    items.push({ n: index + 1, label: `${stage.name} (${stage.schema})`, text, file: stage.output });
  }
  return items;
}

/** Checks the order and the names: every need is an earlier node. Throws on the first problem. */
export function checkPipeline(pipeline: Pipeline): void {
  const seen = new Map<string, PipelineNode>();
  for (const node of pipeline.nodes) {
    if (seen.has(node.name)) {
      throw new Error(`pipeline ${pipeline.name}: the node name ${node.name} is used twice`);
    }
    for (const need of node.needs) {
      if (!seen.has(need)) {
        throw new Error(`pipeline ${pipeline.name}: ${node.name} needs ${need}, which does not come before it`);
      }
    }
    if (node.kind === "stage" && node.fanOut && node.needs.some((need) => seen.get(need)?.kind !== "stage")) {
      throw new Error(`pipeline ${pipeline.name}: the fanned-out stage ${node.name} may need only stages`);
    }
    if (node.kind === "gate") {
      for (const name of [...node.needs, ...node.rework]) {
        if (seen.get(name)?.kind !== "stage") {
          throw new Error(`pipeline ${pipeline.name}: gate ${node.name} refers to ${name}, which is not an earlier stage`);
        }
      }
    }
    seen.set(node.name, node);
  }
}

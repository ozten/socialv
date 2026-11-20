// M1: reverse-engineer the reference video. Probe it, transcribe it (a small
// paid call, through the gateway) while shots are detected, describe each shot
// (one annotator task per shot), assemble the blueprint, and have the owner
// review it against the frames.

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { GateItem } from "../../review/types.ts";
import { Blueprint, Shots } from "../../schemas/analysis.ts";
import type { FanItem, Pipeline, RunContext } from "../pipeline.ts";

/** Where the reference video is, relative to the project folder, when neither the flag nor socialv.json says. */
export const DEFAULT_SOURCE = "source/original.mov";

export const PROBE = "analysis/probe.json";
export const TRANSCRIPT = "analysis/transcript.json";
export const SHOTS = "analysis/shots.json";
export const ANNOTATIONS = "analysis/annotations";
export const BLUEPRINT = "analysis/blueprint.json";
export const SOURCE_ANALYSIS = "analysis/source_analysis.md";

export function analysisPipeline(source = DEFAULT_SOURCE): Pipeline {
  return {
    name: "analysis",
    nodes: [
      {
        kind: "stage",
        name: "probe",
        role: "probe",
        needs: [],
        summary: `Reference video: measure it and extract the audio (${source})`,
        inputs: [],
        output: PROBE,
        schema: "Probe@1",
        params: { source },
      },
      {
        kind: "stage",
        name: "transcribe",
        role: "gateway",
        channel: "spend",
        needs: ["probe"],
        summary: "Reference audio: transcribe with word timings (paid, about 3 cents a minute)",
        inputs: [PROBE],
        output: TRANSCRIPT,
        schema: "Transcript@1",
        params: { op: "transcribe" },
      },
      {
        kind: "stage",
        name: "shots",
        role: "shots",
        needs: ["probe"],
        summary: "Reference video: find the shots and pull keyframes",
        inputs: [PROBE],
        output: SHOTS,
        schema: "Shots@1",
        params: { source },
      },
      {
        // Needs the transcript as well as the shots, so each annotator sees the words spoken in its shot.
        kind: "stage",
        name: "annotate",
        role: "annotator",
        needs: ["shots", "transcribe"],
        summary: "Shot: describe what happens",
        inputs: [],
        output: ANNOTATIONS,
        schema: "ShotAnnotation@1",
        params: {},
        fanOut: { items: shotItems },
      },
      {
        kind: "stage",
        name: "blueprint",
        role: "blueprint",
        needs: ["annotate"],
        summary: "Blueprint: assemble the shot-by-shot analysis of the reference",
        inputs: [PROBE, SHOTS, TRANSCRIPT],
        output: BLUEPRINT,
        schema: "Blueprint@1",
        params: { annotations_dir: ANNOTATIONS },
      },
      {
        kind: "gate",
        name: "blueprint-review",
        needs: ["blueprint"],
        title: "Reference analysis",
        summary:
          "What the system thinks the reference video shows, shot by shot: check the frames against the descriptions. " +
          "Approve to accept the blueprint; revise with notes to have every shot described again.",
        rework: ["annotate", "blueprint"],
        items: blueprintItems,
      },
    ],
  };
}

/** One annotate task per shot in `analysis/shots.json`. */
export async function shotItems(ctx: RunContext): Promise<FanItem[]> {
  const shots = Shots.parse(JSON.parse(await readFile(path.join(ctx.runDir, SHOTS), "utf8")));
  const transcript = await exists(path.join(ctx.runDir, TRANSCRIPT));
  return shots.shots.map((shot) => ({
    shot: shot.shot_id,
    summary: `Shot ${shot.shot_id.replace("shot_", "")}: describe what happens (${fmt(shot.start_sec)}–${fmt(shot.end_sec)})`,
    inputs: [...shot.keyframes.map((k) => k.path), SHOTS, ...(transcript ? [TRANSCRIPT] : [])],
    output: `${ANNOTATIONS}/${shot.shot_id}.json`,
  }));
}

/** Item 1: the written analysis. Then one item per shot: its first frame, beside what the blueprint says it shows. */
export async function blueprintItems(ctx: RunContext): Promise<GateItem[]> {
  const items: GateItem[] = [{ n: 1, label: "Source analysis", file: SOURCE_ANALYSIS }];
  let blueprint: Blueprint;
  try {
    blueprint = Blueprint.parse(JSON.parse(await readFile(path.join(ctx.runDir, BLUEPRINT), "utf8")));
  } catch (error) {
    items[0]!.text = `(cannot read ${BLUEPRINT}: ${(error as Error).message})`;
    return items;
  }
  for (const shot of blueprint.shots) {
    const a = shot.annotation;
    const lines = [
      `${fmt(shot.start_sec)}–${fmt(shot.end_sec)} · ${a.purpose}`,
      `Beats: ${a.action_beats.join("; ")}`,
      `Dialogue: ${shot.dialogue.trim() || "(none)"}`,
    ];
    if (a.on_screen_text.length > 0) lines.push(`On screen: ${a.on_screen_text.map((t) => `"${t}"`).join(", ")}`);
    items.push({
      n: items.length + 1,
      label: shot.shot_id,
      text: lines.join("\n"),
      ...(shot.keyframes[0] ? { file: shot.keyframes[0] } : {}),
      meta: { framing: a.framing, camera: a.camera_motion },
    });
  }
  return items;
}

function fmt(sec: number): string {
  return `${sec.toFixed(1)}s`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

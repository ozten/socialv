// Stage 5: the blueprint. Joins the probe, the shots, each shot's
// annotation and the transcript into one artifact, and writes a short
// human-readable summary for the owner's review.

import path from "node:path";
import { inside, readIfExists, writeAtomic } from "../../step/files.ts";
import { Probe, ShotAnnotation, Shots, Transcript, type Blueprint } from "../../schemas/analysis.ts";
import type { ToolRole } from "../types.ts";

/** The summary the owner reads at the review gate, relative to the run folder. */
export const SOURCE_ANALYSIS_PATH = "analysis/source_analysis.md";

export const blueprint: ToolRole = {
  name: "blueprint",
  kind: "tool",
  async run({ brief, runDir, readInput }) {
    const probe = Probe.parse(await readInput(0));
    const { shots } = Shots.parse(await readInput(1));
    const transcriptPath = brief.inputs[2] ?? null;
    const transcript = transcriptPath === null ? null : Transcript.parse(await readInput(2));
    const annotationsDir = brief.params.annotations_dir ?? "analysis/annotations";
    if (typeof annotationsDir !== "string") {
      throw new Error("params.annotations_dir must be a path relative to the run folder");
    }

    const out: Blueprint["shots"] = [];
    for (const [i, shot] of shots.entries()) {
      const last = i === shots.length - 1;
      const annotation = await readAnnotation(runDir, annotationsDir, shot.shot_id);
      const words = (transcript?.words ?? []).filter((w) => {
        const mid = (w.start_sec + w.end_sec) / 2;
        // The last shot takes a word ending exactly at the end of the video.
        return mid >= shot.start_sec && (mid < shot.end_sec || (last && mid <= shot.end_sec));
      });
      out.push({
        shot_id: shot.shot_id,
        start_sec: shot.start_sec,
        end_sec: shot.end_sec,
        dialogue: words.map((w) => w.text.trim()).filter(Boolean).join(" "),
        keyframes: shot.keyframes.map((k) => k.path),
        annotation,
      });
    }

    const value: Blueprint = {
      source: { duration_sec: probe.duration_sec, width: probe.width, height: probe.height, fps: probe.fps },
      transcript_path: transcriptPath,
      shots: out,
    };
    await writeAtomic(inside(runDir, SOURCE_ANALYSIS_PATH), renderSummary(probe, value, transcript));
    const spoken = transcript ? `${transcript.words.length} words` : "no transcript";
    return { value, summary: `${out.length} shots assembled, ${spoken}, ${probe.duration_sec} s` };
  },
};

async function readAnnotation(runDir: string, dir: string, shotId: string): Promise<ShotAnnotation> {
  const rel = path.posix.join(dir, `${shotId}.json`);
  const text = await readIfExists(inside(runDir, rel));
  if (text === null) {
    throw new Error(`${shotId}: no annotation at ${rel}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${shotId}: the annotation at ${rel} is not JSON: ${(error as Error).message}`);
  }
  const parsed = ShotAnnotation.safeParse(json);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${shotId}: the annotation at ${rel} is invalid: ${errors}`);
  }
  if (parsed.data.shot_id !== shotId) {
    throw new Error(`${shotId}: the annotation at ${rel} is for ${parsed.data.shot_id}`);
  }
  return parsed.data;
}

function renderSummary(probe: Probe, bp: Blueprint, transcript: Transcript | null): string {
  const audio = probe.audio ? `${probe.audio.codec}, ${probe.audio.sample_rate} Hz, ${probe.audio.channels} ch` : "none";
  const lines = [
    "# Source analysis",
    "",
    `- Duration: ${probe.duration_sec} s`,
    `- Frame: ${probe.width}x${probe.height} (${probe.orientation}), ${probe.fps} fps, ${probe.video_codec}`,
    `- Audio: ${audio}`,
    `- Shots: ${bp.shots.length}`,
    `- Transcript: ${transcript ? `${transcript.words.length} words${transcript.language ? `, ${transcript.language}` : ""}` : "none"}`,
  ];
  if (transcript && transcript.events.length > 0) {
    lines.push(`- Sound events: ${transcript.events.map((e) => `${e.label} (${fmt(e.start_sec)}–${fmt(e.end_sec)})`).join(", ")}`);
  }
  for (const shot of bp.shots) {
    const a = shot.annotation;
    lines.push(
      "",
      `## ${shot.shot_id} · ${fmt(shot.start_sec)}–${fmt(shot.end_sec)} (${fmt(shot.end_sec - shot.start_sec)})`,
      "",
      `**Purpose:** ${a.purpose}`,
      "",
      `Framing: ${a.framing}. Camera: ${a.camera_motion}. Setting: ${a.environment}.`,
      "",
      "Action:",
      ...a.action_beats.map((beat, n) => `${n + 1}. ${beat}`),
      "",
      `Dialogue: ${shot.dialogue ? `“${shot.dialogue}”` : "none"}`,
      "",
      `On-screen text: ${a.on_screen_text.length > 0 ? a.on_screen_text.map((t) => `“${t}”`).join(", ") : "none"}`,
    );
    if (a.product_interaction) {
      lines.push("", `Product: ${a.product_interaction}`);
    }
    if (a.notes) {
      lines.push("", `Notes: ${a.notes}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function fmt(sec: number): string {
  return `${sec.toFixed(1)} s`;
}

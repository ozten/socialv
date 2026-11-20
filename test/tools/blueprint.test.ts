import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { Probe, ShotAnnotation, Shots, Transcript } from "../../src/schemas/analysis.ts";
import { Blueprint } from "../../src/schemas/analysis.ts";
import { blueprint } from "../../src/workers/tools/blueprint.ts";
import { tempProject, toolContext, writeJson } from "./media.ts";

const PROBE: Probe = {
  duration_sec: 6, width: 1080, height: 1920, fps: 30, rotation: 0, orientation: "portrait", video_codec: "h264",
  audio: { codec: "aac", sample_rate: 44100, channels: 2 }, audio_path: "analysis/audio.wav", size_bytes: 1000,
};

const SHOTS: Shots = {
  shots: [
    { shot_id: "shot_01", start_sec: 0, end_sec: 2, keyframes: [{ path: "analysis/storyboard/shot_01/1_start.jpg", time_sec: 0.1, reason: "start" }] },
    { shot_id: "shot_02", start_sec: 2, end_sec: 6, keyframes: [
      { path: "analysis/storyboard/shot_02/1_start.jpg", time_sec: 2.1, reason: "start" },
      { path: "analysis/storyboard/shot_02/2_middle.jpg", time_sec: 4, reason: "middle" },
    ] },
  ],
  detector: { method: "ffmpeg-scene", threshold: 0.3 },
};

const word = (text: string, start_sec: number, end_sec: number) => ({ text, start_sec, end_sec, speaker: null });
const TRANSCRIPT: Transcript = {
  language: "en",
  text: "Meet the bottle that keeps it cold",
  words: [
    word("Meet", 0.2, 0.5),
    word("the", 0.6, 0.8),
    // Starts in shot 1, but its midpoint (2.1) is in shot 2.
    word("bottle", 1.8, 2.4),
    word("that", 2.5, 2.7),
    word("keeps", 2.8, 3.1),
    word("it", 3.2, 3.3),
    // Ends exactly at the end of the video.
    word("cold", 5.8, 6),
  ],
  events: [{ label: "music", start_sec: 0, end_sec: 6 }],
  provider: "test",
  model: "test",
};

function annotation(shotId: string): ShotAnnotation {
  return {
    shot_id: shotId, purpose: `purpose of ${shotId}`, framing: "close-up", camera_motion: "static", subjects: ["hand", "bottle"],
    action_beats: ["hand enters", "lifts the bottle"], product_interaction: "lifts it", environment: "kitchen counter",
    on_screen_text: ["STAYS COLD"], notes: null,
  };
}

async function setup(opts: { transcript?: boolean; skip?: string; annotationsDir?: string } = {}) {
  const { projectDir, runDir } = await tempProject();
  await writeJson(path.join(runDir, "analysis/probe.json"), PROBE);
  await writeJson(path.join(runDir, "analysis/shots.json"), SHOTS);
  await writeJson(path.join(runDir, "analysis/transcript.json"), TRANSCRIPT);
  const dir = opts.annotationsDir ?? "analysis/annotations";
  for (const shot of SHOTS.shots) {
    if (shot.shot_id !== opts.skip) {
      await writeJson(path.join(runDir, dir, `${shot.shot_id}.json`), annotation(shot.shot_id));
    }
  }
  const inputs = ["analysis/probe.json", "analysis/shots.json", ...(opts.transcript === false ? [] : ["analysis/transcript.json"])];
  const ctx = toolContext(projectDir, runDir, {
    stage: "blueprint", role: "blueprint", inputs, output: "analysis/blueprint.json", schema: "Blueprint@1",
    params: opts.annotationsDir ? { annotations_dir: opts.annotationsDir } : {},
  });
  return { runDir, ctx };
}

test("assembles the blueprint, assigning words to shots by their midpoint", async () => {
  const { runDir, ctx } = await setup();
  const { value, summary } = await blueprint.run(ctx);
  const bp = Blueprint.parse(value);
  expect(bp.source).toEqual({ duration_sec: 6, width: 1080, height: 1920, fps: 30 });
  expect(bp.transcript_path).toBe("analysis/transcript.json");
  expect(bp.shots.map((s) => s.dialogue)).toEqual(["Meet the", "bottle that keeps it cold"]);
  expect(bp.shots[1]!.keyframes).toEqual(["analysis/storyboard/shot_02/1_start.jpg", "analysis/storyboard/shot_02/2_middle.jpg"]);
  expect(bp.shots[1]!.annotation.purpose).toBe("purpose of shot_02");
  expect(summary).toBe("2 shots assembled, 7 words, 6 s");

  const md = await readFile(path.join(runDir, "analysis/source_analysis.md"), "utf8");
  expect(md).toMatch(/^# Source analysis/);
  expect(md).toContain("1080x1920 (portrait)");
  expect(md).toContain("## shot_02 · 2.0 s–6.0 s");
  expect(md).toContain("**Purpose:** purpose of shot_02");
  expect(md).toContain("1. hand enters");
  expect(md).toContain("Dialogue: “bottle that keeps it cold”");
  expect(md).toContain("On-screen text: “STAYS COLD”");
});

test("without a transcript, dialogue is empty", async () => {
  const { runDir, ctx } = await setup({ transcript: false, annotationsDir: "analysis/notes" });
  const bp = Blueprint.parse((await blueprint.run(ctx)).value);
  expect(bp.transcript_path).toBeNull();
  expect(bp.shots.map((s) => s.dialogue)).toEqual(["", ""]);
  expect(await readFile(path.join(runDir, "analysis/source_analysis.md"), "utf8")).toContain("Transcript: none");
});

test("a missing annotation fails, naming the shot", async () => {
  const { ctx } = await setup({ skip: "shot_02" });
  await expect(blueprint.run(ctx)).rejects.toThrow(/shot_02: no annotation at analysis\/annotations\/shot_02.json/);
});

test("an invalid annotation fails, naming the shot and the problem", async () => {
  const { runDir, ctx } = await setup();
  const bad = { ...annotation("shot_01"), action_beats: [] };
  await writeJson(path.join(runDir, "analysis/annotations/shot_01.json"), bad);
  await expect(blueprint.run(ctx)).rejects.toThrow(/shot_01: the annotation .* is invalid: action_beats/);
  await writeFile(path.join(runDir, "analysis/annotations/shot_01.json"), "{not json");
  await expect(blueprint.run(ctx)).rejects.toThrow(/shot_01: the annotation .* is not JSON/);
  await writeJson(path.join(runDir, "analysis/annotations/shot_01.json"), annotation("shot_02"));
  await expect(blueprint.run(ctx)).rejects.toThrow(/shot_01: the annotation .* is for shot_02/);
});

test("an annotations_dir outside the run folder is refused", async () => {
  const { ctx } = await setup();
  const escaping = { ...ctx, brief: { ...ctx.brief, params: { annotations_dir: "../../.." } } };
  await expect(blueprint.run(escaping)).rejects.toThrow(/not inside the run folder/);
});

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { beforeAll, expect, test } from "vitest";
import { Shots } from "../../src/schemas/analysis.ts";
import { probe } from "../../src/workers/tools/probe.ts";
import { boundaries, parseScores, pickKeyframes, shots } from "../../src/workers/tools/shots.ts";
import { dimensions, makeVideo, tempProject, toolContext, writeJson } from "./media.ts";

let projectDir: string;

beforeAll(async () => {
  ({ projectDir } = await tempProject());
  const src = (name: string) => path.join(projectDir, "source", name);
  // testsrc's counter ticks each second: a motion peak at 1 s and 2 s, away from the 1.5 s middle.
  makeVideo(src("three.mp4"), [
    { src: "testsrc", sec: 3 },
    { src: "smptebars", sec: 2 },
    { src: "color=c=red", sec: 2 },
  ]);
  makeVideo(src("flash.mp4"), [
    { src: "testsrc", sec: 2 },
    { src: "smptebars", sec: 0.3 },
    { src: "color=c=red", sec: 2 },
  ]);
  // Full HD, rotated to portrait: one shot, keyframes capped at 1024 px.
  makeVideo(src("big.mp4"), [{ src: "testsrc2", sec: 3 }], { size: "1920x1080", audio: false, rotation: 90 });
});

/** A fresh run folder with `analysis/probe.json` for `source`, and a context for the shots tool. */
async function setup(source: string, params: Record<string, unknown> = {}) {
  const { runDir } = await tempProject();
  const probeCtx = toolContext(projectDir, runDir, {
    stage: "probe", role: "probe", output: "analysis/probe.json", schema: "Probe@1", params: { source },
  });
  await writeJson(path.join(runDir, "analysis/probe.json"), (await probe.run(probeCtx)).value);
  const ctx = toolContext(projectDir, runDir, {
    stage: "shots", role: "shots", inputs: ["analysis/probe.json"], output: "analysis/shots.json", schema: "Shots@1",
    params: { source, ...params },
  });
  return { runDir, ctx };
}

test("finds the cuts between three segments and extracts keyframes", async () => {
  const { runDir, ctx } = await setup("source/three.mp4");
  const started = Date.now();
  const { value, summary } = await shots.run(ctx);
  const elapsed = Date.now() - started;
  const s = Shots.parse(value);
  expect(s.shots.map((x) => x.shot_id)).toEqual(["shot_01", "shot_02", "shot_03"]);
  expect(s.shots[0]!.start_sec).toBe(0);
  expect(s.shots[1]!.start_sec).toBeCloseTo(3, 1);
  expect(s.shots[2]!.start_sec).toBeCloseTo(5, 1);
  expect(s.shots[2]!.end_sec).toBeCloseTo(7, 1);
  expect(s.detector).toEqual({ method: "ffmpeg-scene", threshold: 0.3 });

  for (const shot of s.shots) {
    const reasons = shot.keyframes.map((k) => k.reason);
    expect(reasons).toContain("start");
    expect(reasons).toContain("middle");
    expect(reasons).toContain("end");
    expect(shot.keyframes.length).toBeLessThanOrEqual(4);
    const times = shot.keyframes.map((k) => k.time_sec);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const [i, k] of shot.keyframes.entries()) {
      expect(k.time_sec).toBeGreaterThanOrEqual(shot.start_sec);
      expect(k.time_sec).toBeLessThan(shot.end_sec);
      expect(i === 0 || k.time_sec - times[i - 1]! >= 0.2).toBe(true);
      expect(k.path).toBe(`analysis/storyboard/${shot.shot_id}/${i + 1}_${k.reason}.jpg`);
      expect(existsSync(path.join(runDir, k.path))).toBe(true);
    }
  }
  // The moving test pattern has motion; the solid red shot has none to find.
  const motion = s.shots[0]!.keyframes.find((k) => k.reason === "motion");
  expect([1, 2].some((t) => Math.abs(motion!.time_sec - t) < 0.05)).toBe(true);
  expect(s.shots[2]!.keyframes.map((k) => k.reason)).not.toContain("motion");
  const count = s.shots.reduce((n, x) => n + x.keyframes.length, 0);
  expect(summary).toBe(`3 shots, ${count} keyframes, 7 s`);
  expect(elapsed).toBeLessThan(10_000);

  // Start and end keyframes sit a little inside the shot, away from the cut; small sources are not upscaled.
  expect(s.shots[1]!.keyframes[0]!.time_sec).toBeGreaterThanOrEqual(s.shots[1]!.start_sec + 0.09);
  expect(s.shots[1]!.keyframes.at(-1)!.time_sec).toBeLessThanOrEqual(s.shots[1]!.end_sec - 0.09);
  expect(dimensions(path.join(runDir, s.shots[1]!.keyframes[0]!.path))).toEqual({ width: 640, height: 360 });
});

test("a single shot covers the whole video; keyframes are capped at 1024 px and portrait", async () => {
  const { runDir, ctx } = await setup("source/big.mp4");
  const s = Shots.parse((await shots.run(ctx)).value);
  expect(s.shots).toHaveLength(1);
  expect(s.shots[0]).toMatchObject({ shot_id: "shot_01", start_sec: 0 });
  expect(s.shots[0]!.end_sec).toBeCloseTo(3, 1);
  for (const k of s.shots[0]!.keyframes) {
    expect(dimensions(path.join(runDir, k.path))).toEqual({ width: 576, height: 1024 });
  }
});

test("min_shot_sec merges a short flash into its neighbour", async () => {
  const merged = Shots.parse((await shots.run((await setup("source/flash.mp4")).ctx)).value);
  expect(merged.shots).toHaveLength(2);
  expect(merged.shots[1]!.start_sec).toBeCloseTo(2, 1);

  const kept = Shots.parse((await shots.run((await setup("source/flash.mp4", { min_shot_sec: 0.1 })).ctx)).value);
  expect(kept.shots).toHaveLength(3);
  expect(kept.shots[2]!.start_sec).toBeCloseTo(2.3, 1);
});

test("max_keyframes_per_shot caps the keyframes, and a rerun replaces the storyboard", async () => {
  const { runDir, ctx } = await setup("source/three.mp4");
  await shots.run(ctx);
  const capped = { ...ctx, brief: { ...ctx.brief, params: { ...ctx.brief.params, max_keyframes_per_shot: 1, threshold: 0.99 } } };
  const s = Shots.parse((await shots.run(capped)).value);
  expect(s.shots).toHaveLength(1);
  expect(s.shots[0]!.keyframes.map((k) => k.reason)).toEqual(["middle"]);
  // Frames from the earlier three-shot run are gone.
  expect(await readdir(path.join(runDir, "analysis/storyboard"))).toEqual(["shot_01"]);
  expect(await readdir(path.join(runDir, "analysis/storyboard/shot_01"))).toEqual(["1_middle.jpg"]);
  expect((await readdir(path.join(runDir, "analysis"))).filter((f) => f.includes(".tmp-"))).toEqual([]);
});

test("refuses a source outside the project folder, and bad params", async () => {
  const { ctx } = await setup("source/three.mp4");
  const withParams = (params: Record<string, unknown>) => ({ ...ctx, brief: { ...ctx.brief, params: { ...ctx.brief.params, ...params } } });
  await expect(shots.run(withParams({ source: "../../etc/passwd" }))).rejects.toThrow(/not inside the project folder/);
  await expect(shots.run(withParams({ threshold: "high" }))).rejects.toThrow(/params.threshold/);
});

test("parsing and boundary logic", () => {
  const text = [
    "frame:0    pts:0       pts_time:0",
    "lavfi.scene_score=0.000000",
    "frame:1    pts:512     pts_time:0.5",
    "lavfi.scene_score=0.900000",
    "frame:2    pts:1024    pts_time:0.7",
    "lavfi.scene_score=0.800000",
    "frame:3    pts:2048    pts_time:3",
    "lavfi.scene_score=0.100000",
    "frame:4    pts:2048    pts_time:5.8",
    "lavfi.scene_score=0.950000",
  ].join("\n");
  const frames = parseScores(text);
  expect(frames).toEqual([
    { t: 0, score: 0 }, { t: 0.5, score: 0.9 }, { t: 0.7, score: 0.8 }, { t: 3, score: 0.1 }, { t: 5.8, score: 0.95 },
  ]);
  // 0.7 is too close to the cut at 0.5; 5.8 is too close to the end.
  expect(boundaries(frames, 0.3, 0.5, 6)).toEqual([[0, 0.5], [0.5, 6]]);
  expect(boundaries([], 0.3, 0.5, 6)).toEqual([[0, 6]]);
  // With no frames inside, keyframes fall back to the shot start, deduplicated to one.
  expect(pickKeyframes([], 1, 2, 0.3, 4)).toEqual([{ t: 1, reason: "middle" }]);
});

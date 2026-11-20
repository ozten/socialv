// The video tools through the real step: claimed tasks on a real board, so
// the schema validation and the output writing are exercised for real roles.

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runDir } from "../../src/config.ts";
import { sha256 } from "../../src/step/files.ts";
import { Probe, Shots } from "../../src/schemas/analysis.ts";
import { startBoard, type TestBoard } from "../helpers/board.ts";
import { claimAndStep, configOf, createTask, taskOf, writeRunFile } from "../step/kit.ts";
import { makeVideo } from "./media.ts";

let tb: TestBoard;
beforeAll(async () => {
  tb = await startBoard();
  await mkdir(path.join(tb.projectDir, "source"), { recursive: true });
  makeVideo(path.join(tb.projectDir, "source/original.mp4"), [
    { src: "testsrc", sec: 2 },
    { src: "smptebars", sec: 2 },
  ]);
});
afterAll(() => tb.stop());

const file = (run: string, rel: string) => path.join(runDir(configOf(tb), run), rel);

test("probe, shots and blueprint run as steps and write validated outputs", async () => {
  const probeTask = await createTask(tb, {
    run: "v1", stage: "probe", role: "probe", output: "analysis/probe.json", schema: "Probe@1",
    params: { source: "source/original.mp4" },
  });
  expect((await claimAndStep(tb, "probe", probeTask.id)).code).toBe(0);
  const probeText = await readFile(file("v1", "analysis/probe.json"), "utf8");
  expect(Probe.parse(JSON.parse(probeText)).orientation).toBe("landscape");
  expect(existsSync(file("v1", "analysis/audio.wav"))).toBe(true);
  const done = await taskOf(tb, probeTask.id);
  expect(done.task?.state).toBe("completed");
  expect(done.task?.result).toBe(`640x360 landscape, 4 s at 30 fps, audio extracted\noutput: analysis/probe.json sha256:${sha256(probeText)}`);

  const shotsTask = await createTask(tb, {
    run: "v1", stage: "shots", role: "shots", inputs: ["analysis/probe.json"], output: "analysis/shots.json", schema: "Shots@1",
    params: { source: "source/original.mp4" },
  });
  expect((await claimAndStep(tb, "shots", shotsTask.id)).code).toBe(0);
  const shots = Shots.parse(JSON.parse(await readFile(file("v1", "analysis/shots.json"), "utf8")));
  expect(shots.shots).toHaveLength(2);
  expect((await taskOf(tb, shotsTask.id)).task?.result).toMatch(/^2 shots, \d+ keyframes, 4 s\n/);

  for (const shot of shots.shots) {
    await writeRunFile(tb, "v1", `analysis/annotations/${shot.shot_id}.json`, {
      shot_id: shot.shot_id, purpose: "test", framing: "wide", camera_motion: "static", subjects: [], action_beats: ["pattern"],
      product_interaction: null, environment: "studio", on_screen_text: [], notes: null,
    });
  }
  const bpTask = await createTask(tb, {
    run: "v1", stage: "blueprint", role: "blueprint", inputs: ["analysis/probe.json", "analysis/shots.json"],
    output: "analysis/blueprint.json", schema: "Blueprint@1",
  });
  expect((await claimAndStep(tb, "blueprint", bpTask.id)).code).toBe(0);
  expect((await taskOf(tb, bpTask.id)).task?.state).toBe("completed");
  expect(existsSync(file("v1", "analysis/blueprint.json"))).toBe(true);
  expect(existsSync(file("v1", "analysis/source_analysis.md"))).toBe(true);
});

test("a source outside the project folder fails the task", async () => {
  const task = await createTask(tb, {
    run: "v2", stage: "probe", role: "probe", output: "analysis/probe.json", schema: "Probe@1",
    params: { source: "../../outside.mov" },
  });
  expect((await claimAndStep(tb, "probe", task.id)).code).toBe(1);
  const after = await taskOf(tb, task.id);
  expect(after.task?.state).toBe("failed");
  expect(after.task?.reason).toMatch(/not inside the project folder/);
  expect(existsSync(file("v2", "analysis/probe.json"))).toBe(false);
});

test("a missing annotation fails the blueprint task, naming the shot", async () => {
  await writeRunFile(tb, "v3", "analysis/probe.json", JSON.parse(await readFile(file("v1", "analysis/probe.json"), "utf8")));
  await writeRunFile(tb, "v3", "analysis/shots.json", JSON.parse(await readFile(file("v1", "analysis/shots.json"), "utf8")));
  const task = await createTask(tb, {
    run: "v3", stage: "blueprint", role: "blueprint", inputs: ["analysis/probe.json", "analysis/shots.json"],
    output: "analysis/blueprint.json", schema: "Blueprint@1",
  });
  expect((await claimAndStep(tb, "blueprint", task.id)).code).toBe(1);
  expect((await taskOf(tb, task.id)).task?.reason).toMatch(/shot_01: no annotation/);
});

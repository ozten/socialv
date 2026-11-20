import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, expect, test } from "vitest";
import { Probe } from "../../src/schemas/analysis.ts";
import { probe } from "../../src/workers/tools/probe.ts";
import { makeVideo, tempProject, toolContext } from "./media.ts";

let projectDir: string;
let runDir: string;

beforeAll(async () => {
  ({ projectDir, runDir } = await tempProject());
  makeVideo(path.join(projectDir, "source/landscape.mp4"), [{ src: "testsrc", sec: 2 }]);
  // A phone video: stored landscape, displayed portrait, no audio.
  makeVideo(path.join(projectDir, "source/phone.mp4"), [{ src: "testsrc", sec: 1.5 }], { audio: false, rotation: 90 });
});

const ctx = (source: string) =>
  toolContext(projectDir, runDir, { stage: "probe", role: "probe", output: "analysis/probe.json", schema: "Probe@1", params: { source } });

test("probes a landscape video and extracts its audio as mono 16 kHz WAV", async () => {
  const { value, summary } = await probe.run(ctx("source/landscape.mp4"));
  const p = Probe.parse(value);
  expect(p).toMatchObject({ width: 640, height: 360, rotation: 0, orientation: "landscape", video_codec: "h264", fps: 30 });
  expect(p.duration_sec).toBeCloseTo(2, 1);
  expect(p.audio).toMatchObject({ codec: "aac", sample_rate: 44100, channels: 1 });
  expect(p.size_bytes).toBeGreaterThan(0);
  expect(p.audio_path).toBe("analysis/audio.wav");
  expect(summary).toMatch(/640x360 landscape/);

  const { stdout } = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path.join(runDir, "analysis/audio.wav")], {
    encoding: "utf8",
  });
  const wav = (JSON.parse(stdout) as { streams: { codec_name: string; sample_rate: string; channels: number }[] }).streams[0]!;
  expect(wav).toMatchObject({ codec_name: "pcm_s16le", sample_rate: "16000", channels: 1 });
  // No temporary files left behind.
  expect((await readdir(path.join(runDir, "analysis"))).filter((f) => f.includes(".tmp-"))).toEqual([]);
});

test("running twice overwrites the audio safely", async () => {
  await probe.run(ctx("source/landscape.mp4"));
  const { value } = await probe.run(ctx("source/landscape.mp4"));
  expect(Probe.parse(value).audio_path).toBe("analysis/audio.wav");
});

test("applies rotation so a phone video reports portrait, and handles no audio", async () => {
  const { runDir: emptyRun } = await tempProject();
  const c = toolContext(projectDir, emptyRun, {
    stage: "probe", role: "probe", output: "analysis/probe.json", schema: "Probe@1", params: { source: "source/phone.mp4" },
  });
  const p = Probe.parse((await probe.run(c)).value);
  expect(p).toMatchObject({ width: 360, height: 640, rotation: 90, orientation: "portrait", audio: null, audio_path: null });
  expect(existsSync(path.join(emptyRun, "analysis/audio.wav"))).toBe(false);
});

test("refuses a source outside the project folder", async () => {
  await expect(probe.run(ctx("../outside.mp4"))).rejects.toThrow(/not inside the project folder/);
  await expect(probe.run(ctx("/etc/hosts"))).rejects.toThrow(/not inside the project folder/);
});

test("a missing source or a non-video fails clearly", async () => {
  await expect(probe.run(ctx("source/nope.mp4"))).rejects.toThrow(/does not exist/);
  await writeFile(path.join(projectDir, "source/notes.mp4"), "not a video");
  // ffprobe's own complaint is carried in the error.
  await expect(probe.run(ctx("source/notes.mp4"))).rejects.toThrow(/ffprobe failed[\s\S]*Invalid data/);
  await expect(probe.run(toolContext(projectDir, runDir, {
    stage: "probe", role: "probe", output: "analysis/probe.json", schema: "Probe@1",
  }))).rejects.toThrow(/params.source/);
});

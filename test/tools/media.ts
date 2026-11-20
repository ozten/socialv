// Synthetic videos and a hand-built ToolContext, for testing the video tools.

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../../src/config.ts";
import { Brief, type BriefInput } from "../../src/schemas/brief.ts";
import type { ToolContext } from "../../src/workers/types.ts";

/** A temporary project folder with a run folder inside it. */
export async function tempProject(): Promise<{ projectDir: string; runDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "socialv-tools-"));
  const projectDir = path.join(root, "project");
  const runDir = path.join(projectDir, "runs", "r1");
  await mkdir(path.join(projectDir, "source"), { recursive: true });
  await mkdir(runDir, { recursive: true });
  return { projectDir, runDir };
}

export function ffmpegSync(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr}`);
  }
}

export interface Segment {
  /** A lavfi video source, such as `testsrc` or `color=c=red`. */
  src: string;
  sec: number;
}

/**
 * Concatenates solid or pattern segments into one H.264 file, with a sine
 * audio track unless `audio` is false, and optional display rotation.
 */
export function makeVideo(
  out: string,
  segments: Segment[],
  opts: { size?: string; audio?: boolean; rotation?: number } = {},
): void {
  const size = opts.size ?? "640x360";
  const total = segments.reduce((n, s) => n + s.sec, 0);
  const inputs = segments.flatMap((s) => ["-f", "lavfi", "-i", `${s.src}${s.src.includes("=") ? ":" : "="}size=${size}:rate=30:duration=${s.sec}`]);
  const audio = opts.audio === false ? [] : ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${total}`];
  const concat = `${segments.map((_, i) => `[${i}:v]`).join("")}concat=n=${segments.length}:v=1:a=0[v]`;
  const maps = ["-map", "[v]", ...(opts.audio === false ? [] : ["-map", `${segments.length}:a`, "-c:a", "aac"])];
  const plain = opts.rotation === undefined ? out : out.replace(/\.mp4$/, ".plain.mp4");
  ffmpegSync([
    ...inputs, ...audio, "-filter_complex", concat, ...maps,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", String(total), plain,
  ]);
  if (opts.rotation !== undefined) {
    ffmpegSync(["-display_rotation", String(opts.rotation), "-i", plain, "-c", "copy", out]);
  }
}

/** Width and height of an image or video, as ffprobe reports them. */
export function dimensions(file: string): { width: number; height: number } {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file],
    { encoding: "utf8" },
  );
  const stream = (JSON.parse(result.stdout) as { streams: { width: number; height: number }[] }).streams[0]!;
  return { width: stream.width, height: stream.height };
}

/** A ToolContext for calling a tool's `run` directly, without a board. */
export function toolContext(projectDir: string, runDir: string, brief: Omit<BriefInput, "v" | "run">): ToolContext {
  const parsed = Brief.parse({ v: 1, run: "r1", ...brief });
  const config: Config = {
    boardUrl: "http://127.0.0.1:1",
    boardName: "test",
    principal: "local",
    owner: "local",
    projectDir,
    reviewUrl: "http://127.0.0.1:2",
    runtime: "fake",
  };
  return {
    config,
    brief: parsed,
    taskId: "t1",
    runDir,
    async readInput(index = 0) {
      const rel = parsed.inputs[index];
      if (rel === undefined) {
        throw new Error(`the brief has no input ${index}`);
      }
      return JSON.parse(await readFile(path.join(runDir, rel), "utf8"));
    },
  };
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

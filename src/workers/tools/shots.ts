// Stage 3: shot boundaries and keyframes. One decode of the video, at low
// resolution, prints ffmpeg's scene-change score for every frame. Scores
// above the threshold are cuts; inside a shot, the highest score below the
// threshold marks its point of greatest motion. Keyframes are then pulled
// one at a time with a fast seek.

import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { inside } from "../../step/files.ts";
import { Probe, type Shots } from "../../schemas/analysis.ts";
import type { ToolRole } from "../types.ts";
import { ffmpeg, numberParam, sourcePath } from "./ffmpeg.ts";

/** Where keyframes go, relative to the run folder. */
export const STORYBOARD_DIR = "analysis/storyboard";
/** Longest side of a keyframe, in pixels: they are read by a vision model. */
export const KEYFRAME_MAX_SIDE = 1024;
/** Keyframes closer together than this are the same frame, for our purposes. */
const DEDUPE_SEC = 0.2;
/** How far inside a shot the start and end keyframes sit, so they avoid the cut itself. */
const EDGE_SEC = 0.1;
/** A shot this long or longer also gets a motion keyframe. */
const MOTION_MIN_SEC = 2;
/** Width of the frames scored for scene change. Small is fast and enough. */
const SCAN_WIDTH = 320;
const EXTRACT_CONCURRENCY = 4;

type Reason = "start" | "middle" | "end" | "motion";
/** When the cap bites, keep keyframes in this order. */
const PRIORITY: Reason[] = ["middle", "start", "end", "motion"];

export interface Frame {
  t: number;
  score: number;
}

export const shots: ToolRole = {
  name: "shots",
  kind: "tool",
  async run({ config, brief, runDir, readInput }) {
    const source = await sourcePath(config, brief.params.source);
    const threshold = numberParam(brief.params, "threshold", 0.3, 0.01, 1);
    const minShot = numberParam(brief.params, "min_shot_sec", 0.5, 0, 3600);
    const maxKeyframes = numberParam(brief.params, "max_keyframes_per_shot", 4, 1, 4);
    const info = Probe.parse(await readInput(0));
    const duration = info.duration_sec;

    const frames = await scan(source, duration);
    const bounds = boundaries(frames, threshold, minShot, duration);

    const plan = bounds.map(([start, end], i) => {
      const shotId = `shot_${String(i + 1).padStart(2, "0")}`;
      const picks = pickKeyframes(frames, start, end, threshold, Math.floor(maxKeyframes));
      return {
        shot_id: shotId,
        start_sec: round(start),
        end_sec: round(end),
        keyframes: picks.map((k, n) => ({
          path: `${STORYBOARD_DIR}/${shotId}/${n + 1}_${k.reason}.jpg`,
          time_sec: round(k.t),
          reason: k.reason,
        })),
      };
    });

    // Build the storyboard beside the old one and swap it in, so a rerun
    // never leaves frames from an earlier, different cut.
    const final = inside(runDir, STORYBOARD_DIR);
    const staging = `${final}.tmp-${process.pid}-${Date.now().toString(36)}`;
    await rm(staging, { recursive: true, force: true });
    try {
      const jobs = plan.flatMap((shot) =>
        shot.keyframes.map((k) => () => extractFrame(source, k.time_sec, path.join(staging, path.relative(STORYBOARD_DIR, k.path)))),
      );
      await pool(jobs, EXTRACT_CONCURRENCY);
      await rm(final, { recursive: true, force: true });
      await rename(staging, final);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    const value: Shots = { shots: plan, detector: { method: "ffmpeg-scene", threshold } };
    const count = plan.reduce((n, s) => n + s.keyframes.length, 0);
    return {
      value,
      summary: `${plan.length} shot${plan.length === 1 ? "" : "s"}, ${count} keyframes, ${round(duration, 1)} s`,
    };
  },
};

/** One decode of the video: the scene-change score of every frame, in order. */
async function scan(source: string, duration: number): Promise<Frame[]> {
  const filter = `scale=${SCAN_WIDTH}:-2,select='gte(scene,0)',metadata=mode=print:key=lavfi.scene_score:file=-`;
  const { stdout } = await ffmpeg(
    ["-i", source, "-an", "-sn", "-dn", "-map", "0:v:0", "-vf", filter, "-f", "null", "-"],
    Math.max(120_000, duration * 10_000),
  );
  return parseScores(stdout);
}

/** Parses `metadata=print` output: a `pts_time:` line per frame, then its `lavfi.scene_score=`. */
export function parseScores(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of text.split("\n")) {
    const time = /pts_time:\s*(-?[\d.]+(?:e-?\d+)?)/.exec(line);
    if (time) {
      frames.push({ t: Math.max(0, Number(time[1])), score: 0 });
      continue;
    }
    const score = /lavfi\.scene_score=([\d.]+)/.exec(line);
    const last = frames[frames.length - 1];
    if (score && last) {
      last.score = Number(score[1]);
    }
  }
  return frames;
}

/**
 * Shots as [start, end] pairs covering the whole video. A cut is a frame
 * scoring above `threshold`; a cut closer than `minShot` to the previous
 * kept cut, or to the end, is dropped, so short flashes merge into a
 * neighbour. Always at least one shot.
 */
export function boundaries(frames: Frame[], threshold: number, minShot: number, duration: number): [number, number][] {
  const cuts: number[] = [];
  let last = 0;
  for (const frame of frames) {
    if (frame.score > threshold && frame.t - last >= minShot && duration - frame.t >= minShot && frame.t > 0) {
      cuts.push(frame.t);
      last = frame.t;
    }
  }
  const edges = [0, ...cuts, duration];
  return edges.slice(0, -1).map((start, i) => [start, edges[i + 1]!]);
}

/**
 * Keyframes for one shot: just after the start, the middle, just before
 * the end, and for a long enough shot the frame of greatest motion (the
 * highest scene score below the cut threshold). Frames closer than
 * DEDUPE_SEC are dropped; at most `max`, in time order.
 */
export function pickKeyframes(
  frames: Frame[],
  start: number,
  end: number,
  threshold: number,
  max: number,
): { t: number; reason: Reason }[] {
  const inShot = frames.filter((f) => f.t >= start && f.t < end);
  const first = inShot[0]?.t ?? start;
  const lastFrame = inShot[inShot.length - 1]?.t ?? first;
  const candidates: Record<Reason, number | null> = {
    start: inShot.find((f) => f.t >= start + EDGE_SEC)?.t ?? first,
    end: [...inShot].reverse().find((f) => f.t <= end - EDGE_SEC)?.t ?? lastFrame,
    middle: nearest(inShot, (start + end) / 2) ?? first,
    motion: null,
  };
  if (end - start >= MOTION_MIN_SEC) {
    let best: Frame | null = null;
    for (const f of inShot) {
      if (f.t >= start + 3 * EDGE_SEC && f.t <= end - 3 * EDGE_SEC && f.score <= threshold && f.score > (best?.score ?? 0)) {
        best = f;
      }
    }
    candidates.motion = best?.t ?? null;
  }
  const kept: { t: number; reason: Reason }[] = [];
  for (const reason of PRIORITY) {
    const t = candidates[reason];
    if (t !== null && kept.length < max && kept.every((k) => Math.abs(k.t - t) >= DEDUPE_SEC)) {
      kept.push({ t, reason });
    }
  }
  return kept.sort((a, b) => a.t - b.t);
}

function nearest(frames: Frame[], t: number): number | null {
  let best: number | null = null;
  for (const f of frames) {
    if (best === null || Math.abs(f.t - t) < Math.abs(best - t)) {
      best = f.t;
    }
  }
  return best;
}

/** One frame as a JPEG, longest side at most KEYFRAME_MAX_SIDE, never upscaled. */
async function extractFrame(source: string, t: number, out: string): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true });
  const m = KEYFRAME_MAX_SIDE;
  const scale = `scale='if(gte(iw,ih),min(${m},iw),-2)':'if(gte(iw,ih),-2,min(${m},ih))'`;
  // Seek a hair early: the printed frame time is rounded, and seeking past
  // the last frame would yield nothing.
  await ffmpeg(
    ["-y", "-ss", Math.max(0, t - 0.001).toFixed(4), "-i", source, "-map", "0:v:0", "-frames:v", "1", "-vf", scale, "-q:v", "4", out],
    60_000,
  );
  const info = await stat(out).catch(() => null);
  if (!info || info.size === 0) {
    throw new Error(`ffmpeg wrote no keyframe at ${t.toFixed(3)} s`);
  }
}

async function pool(jobs: (() => Promise<void>)[], size: number): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (next < jobs.length && failure === null) {
      try {
        await jobs[next++]!();
      } catch (error) {
        failure ??= error;
      }
    }
  };
  // Every worker finishes before we return, so no ffmpeg is still writing when the caller cleans up.
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
  if (failure !== null) {
    throw failure;
  }
}

function round(value: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

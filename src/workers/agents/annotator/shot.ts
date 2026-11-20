// What an annotator is told about its shot, read from the run folder: the
// shot's times and keyframes from shots.json, and the transcript words that
// fall inside it. Shared by the prompt and the fake.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Shots, Transcript } from "../../../schemas/analysis.ts";
import type { Brief } from "../../../schemas/brief.ts";

export interface ShotFacts {
  shotId: string;
  /** 1-based position in the video, and the number of shots. */
  index: number;
  count: number;
  startSec: number;
  endSec: number;
  keyframes: { path: string; absPath: string; timeSec: number; reason: string }[];
  /** The words spoken during the shot, or null when there is no transcript. */
  words: string | null;
  /** Non-speech sounds the transcriber tagged during the shot. */
  sounds: { label: string; startSec: number; endSec: number }[];
}

/** Reads the facts for `brief.shot`. Throws if the brief names no shot or shots.json does not have it. */
export function shotFacts(runDir: string, brief: Brief): ShotFacts {
  if (!brief.shot) throw new Error("the brief names no shot");
  const shotsPath = brief.inputs.find((p) => p.endsWith("shots.json"));
  if (!shotsPath) throw new Error("the brief has no shots.json input");
  const shots = Shots.parse(JSON.parse(readFileSync(path.join(runDir, shotsPath), "utf8"))).shots;
  const index = shots.findIndex((s) => s.shot_id === brief.shot);
  const shot = shots[index];
  if (!shot) throw new Error(`${shotsPath} has no shot ${brief.shot}`);

  const transcriptPath = brief.inputs.find((p) => p.endsWith("transcript.json"));
  let words: string | null = null;
  let sounds: ShotFacts["sounds"] = [];
  if (transcriptPath) {
    const transcript = Transcript.parse(JSON.parse(readFileSync(path.join(runDir, transcriptPath), "utf8")));
    const inside = (t: { start_sec: number; end_sec: number }) => t.start_sec < shot.end_sec && t.end_sec > shot.start_sec;
    words = transcript.words.filter(inside).map((w) => w.text.trim()).filter(Boolean).join(" ");
    sounds = transcript.events.filter(inside).map((e) => ({ label: e.label, startSec: e.start_sec, endSec: e.end_sec }));
  }
  return {
    shotId: shot.shot_id,
    index: index + 1,
    count: shots.length,
    startSec: shot.start_sec,
    endSec: shot.end_sec,
    keyframes: shot.keyframes.map((k) => ({
      path: k.path,
      absPath: path.join(runDir, k.path),
      timeSec: k.time_sec,
      reason: k.reason,
    })),
    words,
    sounds,
  };
}

export const sec = (n: number) => `${n.toFixed(2)}s`;

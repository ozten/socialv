// Fake workers for the analysis pipeline, written with the SDK: each claims
// its role's tasks in one channel and writes a valid output file.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClaimedTask } from "openboardlol";
import { spendChannel, workChannel } from "../../src/channels.ts";
import { runDir, type Config } from "../../src/config.ts";
import { Blueprint, ShotAnnotation, Shots, type Probe, type Transcript } from "../../src/schemas/analysis.ts";
import { parseBrief, type Brief } from "../../src/schemas/brief.ts";
import type { TestBoard } from "../helpers/board.ts";
import { testConfig, type Behavior } from "./helpers.ts";

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${file}.tmp`, file);
}

export const shotId = (i: number) => `shot_${String(i).padStart(2, "0")}`;

/** shots.json with `count` one-second shots, two keyframes each. */
export function fakeShots(count: number): Shots {
  return {
    shots: Array.from({ length: count }, (_, i) => ({
      shot_id: shotId(i + 1),
      start_sec: i,
      end_sec: i + 1,
      keyframes: [
        { path: `analysis/storyboard/${shotId(i + 1)}/start.jpg`, time_sec: i + 0.1, reason: "start" as const },
        { path: `analysis/storyboard/${shotId(i + 1)}/end.jpg`, time_sec: i + 0.9, reason: "end" as const },
      ],
    })),
    detector: { method: "fake", threshold: 0.3 },
  };
}

/** Does a stage's fake work. `shotCount` says how many shots the shots stage finds. */
export async function analysisWork(config: Config, brief: Brief, shotCount: number): Promise<void> {
  const dir = runDir(config, brief.run);
  const out = path.join(dir, brief.output);
  switch (brief.role) {
    case "probe": {
      const probe: Probe = {
        duration_sec: shotCount,
        width: 720,
        height: 1280,
        fps: 30,
        rotation: 0,
        orientation: "portrait",
        video_codec: "h264",
        audio: { codec: "aac", sample_rate: 44100, channels: 2 },
        audio_path: "analysis/audio.wav",
        size_bytes: 1000,
      };
      return writeJson(out, probe);
    }
    case "gateway": {
      const transcript: Transcript = {
        language: "en",
        text: "hello there",
        words: [
          { text: "hello", start_sec: 0.2, end_sec: 0.5, speaker: null },
          { text: "there", start_sec: 1.2, end_sec: 1.5, speaker: null },
        ],
        events: [],
        provider: "fake",
        model: "fake",
      };
      return writeJson(out, transcript);
    }
    case "shots":
      return writeJson(out, fakeShots(shotCount));
    case "annotator": {
      const annotation: ShotAnnotation = {
        shot_id: brief.shot!,
        purpose: `purpose of ${brief.shot}${brief.notes ? ` (${brief.notes})` : ""}`,
        framing: "close-up",
        camera_motion: "static",
        subjects: [],
        action_beats: [`${brief.shot} happens`],
        product_interaction: null,
        environment: "studio",
        on_screen_text: [],
        notes: brief.notes,
      };
      return writeJson(out, annotation);
    }
    case "blueprint": {
      const shots = Shots.parse(JSON.parse(await readFile(path.join(dir, "analysis/shots.json"), "utf8")));
      const annotationsDir = String(brief.params.annotations_dir);
      const rows = [];
      for (const shot of shots.shots) {
        // Throws if an annotation is missing: the blueprint must run after all of them.
        const annotation = ShotAnnotation.parse(
          JSON.parse(await readFile(path.join(dir, annotationsDir, `${shot.shot_id}.json`), "utf8")),
        );
        rows.push({
          shot_id: shot.shot_id,
          start_sec: shot.start_sec,
          end_sec: shot.end_sec,
          dialogue: shot.shot_id === "shot_01" ? "hello" : "",
          keyframes: shot.keyframes.map((k) => k.path),
          annotation,
        });
      }
      const blueprint: Blueprint = {
        source: { duration_sec: shotCount, width: 720, height: 1280, fps: 30 },
        transcript_path: "analysis/transcript.json",
        shots: rows,
      };
      await writeJson(path.join(dir, "analysis/source_analysis.md"), `# Source analysis\n\n${rows.length} shots.\n`);
      return writeJson(out, Blueprint.parse(blueprint));
    }
    default:
      throw new Error(`no fake work for role ${brief.role}`);
  }
}

/** One fake worker for `role` in one channel of the run. */
export function startAnalysisWorker(
  tb: TestBoard,
  channel: string,
  role: string,
  shotCount: number,
  behavior?: Behavior,
) {
  const controller = new AbortController();
  const handle = tb.as(role);
  const config = testConfig(tb);
  const loop = (async () => {
    while (!controller.signal.aborted) {
      let claim: ClaimedTask | null;
      try {
        claim = await handle.tasks.claim({ channel, wait: 2 }, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      }
      if (!claim) continue;
      const brief = parseBrief(claim.task.text);
      if ((await behavior?.(claim, brief)) === "handled") continue;
      await analysisWork(config, brief, shotCount);
      await claim.complete(`done\n${brief.output}`);
    }
  })();
  return {
    async stop() {
      controller.abort();
      await loop;
    },
  };
}

/** Every worker the analysis pipeline needs; the gateway works the spend channel. */
export function startAnalysisWorkers(
  tb: TestBoard,
  run: string,
  shotCount: number,
  behaviors: Record<string, Behavior> = {},
) {
  const workers = [
    startAnalysisWorker(tb, spendChannel(run), "gateway", shotCount, behaviors.gateway),
    ...["probe", "shots", "annotator", "blueprint"].map((role) =>
      startAnalysisWorker(tb, workChannel(run), role, shotCount, behaviors[role]),
    ),
  ];
  return { stop: () => Promise.all(workers.map((w) => w.stop())) };
}

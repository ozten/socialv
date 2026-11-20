import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "openboardlol";
import { OPS, spendChannel } from "../../src/channels.ts";
import { runDir } from "../../src/config.ts";
import { Ledger, type ActionRow } from "../../src/gateway/ledger.ts";
import { formatBrief } from "../../src/schemas/brief.ts";
import type { TestBoard } from "../helpers/board.ts";
import { configOf } from "../step/kit.ts";

/** Plays the conductor: a transcription task in `spend/<run>`, kept for the gateway. */
export async function createSpendTask(
  tb: TestBoard,
  run: string,
  opts: { stage?: string; output?: string; params?: Record<string, unknown> } = {},
): Promise<Message> {
  const stage = opts.stage ?? "transcribe";
  const { task } = await tb.as("conductor").tasks.create(spendChannel(run), {
    text: formatBrief(`Transcribe the reference (${stage})`, {
      v: 1,
      run,
      stage,
      role: "gateway",
      inputs: ["analysis/probe.json"],
      output: opts.output ?? "analysis/transcript.json",
      schema: "Transcript@1",
      params: opts.params ?? { op: "transcribe" },
    }),
    for: "gateway",
  });
  return task;
}

/** A probe and a stand-in audio file in the run folder. */
export async function writeProbe(tb: TestBoard, run: string, durationSec: number, withAudio = true): Promise<void> {
  const dir = runDir(configOf(tb), run);
  await mkdir(path.join(dir, "analysis"), { recursive: true });
  if (withAudio) {
    await writeFile(path.join(dir, "analysis", "audio.wav"), `fake audio for ${run} ${durationSec}`);
  }
  const probe = {
    duration_sec: durationSec,
    width: 720,
    height: 1280,
    fps: 30,
    rotation: 0,
    orientation: "portrait",
    video_codec: "h264",
    audio: withAudio ? { codec: "aac", sample_rate: 44100, channels: 2 } : null,
    audio_path: withAudio ? "analysis/audio.wav" : null,
    size_bytes: 1000,
  };
  await writeFile(path.join(dir, "analysis", "probe.json"), JSON.stringify(probe));
}

export function ledgerRow(tb: TestBoard, run: string, actionId: string): ActionRow | undefined {
  const ledger = new Ledger(runDir(configOf(tb), run), tb.projectDir);
  try {
    return ledger.get(actionId);
  } finally {
    ledger.close();
  }
}

/** Texts of the root messages in `ops`. */
export async function opsTexts(tb: TestBoard): Promise<string[]> {
  const { threads } = await tb.as("conductor").threads({ channel: OPS, limit: 100 });
  return threads.map((t) => t.root.text);
}

export async function replyTexts(tb: TestBoard, taskId: string): Promise<string[]> {
  const thread = await tb.as("conductor").thread(taskId);
  return thread.replies.map((m) => m.text);
}

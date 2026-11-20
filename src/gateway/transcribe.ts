// Operation `transcribe` (pipeline stage 2): `analysis/probe.json` in,
// `analysis/transcript.json` (Transcript@1) out, through the paid path.

import { readFile } from "node:fs/promises";
import { Probe, Transcript } from "../schemas/analysis.ts";
import { inside, sha256 } from "../step/files.ts";
import { runPaidAction, type GatewayContext } from "./action.ts";
import { appendCostLog } from "./cost-log.ts";
import { SPEECH_TO_TEXT } from "./prices.ts";
import { selectTranscriber, type TranscribeInput } from "./transcribers.ts";

export interface TranscribeParams {
  /** Override the endpoint (it must be in the price table). */
  endpoint?: string;
}

export async function transcribe(
  gw: GatewayContext,
  probeValue: unknown,
  params: TranscribeParams = {},
): Promise<{ value: Transcript; summary: string }> {
  const probe = Probe.parse(probeValue);
  const endpoint = params.endpoint ?? SPEECH_TO_TEXT;
  const transcriber = selectTranscriber(gw.config.projectDir, gw.config.runtime);

  if (!probe.audio || !probe.audio_path) {
    appendCostLog(gw.runDir, {
      run: gw.run, task_id: gw.taskId, action_id: "", operation: "transcribe", endpoint,
      event: "free", actual_usd: 0, note: "the probe found no audio: empty transcript, nothing sent",
    });
    const value: Transcript = { language: null, text: "", words: [], events: [], provider: "none", model: "none" };
    return { value, summary: "no audio track: empty transcript at no cost" };
  }

  const audioPath = inside(gw.runDir, probe.audio_path);
  const input: TranscribeInput = {
    audio_path: audioPath,
    audio_sha256: sha256(await readFile(audioPath)),
    duration_sec: probe.duration_sec,
    diarize: true,
    tag_audio_events: true,
  };
  const outcome = await runPaidAction(gw, {
    operation: "transcribe",
    endpoint,
    // The digest covers what is sent, not where the file happens to live.
    input: { ...input, audio_path: probe.audio_path },
    basis: { audio_sec: probe.duration_sec },
    provider: {
      name: transcriber.name,
      ready: () => transcriber.ready(),
      prepare: (ep) => transcriber.prepare(ep, input),
      submit: (ep, request) => transcriber.submit(ep, request),
      wait: (ep, id, opts) => transcriber.wait(ep, id, opts),
    },
  });
  const value = Transcript.parse(transcriber.toTranscript(outcome.result, endpoint));
  const cost = outcome.row.actual_usd ?? outcome.row.estimated_usd;
  const how = outcome.replayed ? "recorded result, " : "";
  return {
    value,
    summary: `transcribed ${probe.duration_sec.toFixed(1)}s of audio: ${value.words.length} words, ${value.events.length} events, $${cost.toFixed(4)} (${how}request ${outcome.row.request_id})`,
  };
}

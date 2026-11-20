// Speech-to-text providers behind one interface. `fal` is ElevenLabs Scribe
// on fal.ai; `fake` is deterministic and offline, for tests and the fake runtime.
//
// fal's schema, read 2026-11-20 from
// https://fal.ai/models/fal-ai/elevenlabs/speech-to-text/llms.txt and
// https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/elevenlabs/speech-to-text
//   input:  audio_url (required), language_code?, tag_audio_events (default true), diarize (default true)
//   output: text, language_code, language_probability,
//           words[]: { text, start?: number|null, end?: number|null,
//                      type: "word" | "spacing" | "audio_event", speaker_id?: string|null }
// Times are seconds.

import { createFalClient, ApiError, type FalClient } from "@fal-ai/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Transcript } from "../schemas/analysis.ts";
import { JobFailed, SubmitRejected, type QueueProvider } from "./action.ts";
import { MissingKeyError, providerKey } from "./keys.ts";

/** The logical request a transcription is bound to. Its digest identifies the action. */
export interface TranscribeInput {
  /** The audio file, absolute. Not part of the digest; its content hash is. */
  audio_path: string;
  audio_sha256: string;
  duration_sec: number;
  diarize: boolean;
  tag_audio_events: boolean;
}

export interface Transcriber extends QueueProvider {
  /** The model name recorded in the transcript. */
  model(endpoint: string): string;
  /** Maps the provider's JSON result to Transcript@1. */
  toTranscript(result: unknown, endpoint: string): Transcript;
}

// ----- fal's response, and its mapping ------------------------------------------

const ScribeWord = z.object({
  text: z.string(),
  start: z.number().nullable().optional(),
  end: z.number().nullable().optional(),
  type: z.string(),
  speaker_id: z.string().nullable().optional(),
});
const ScribeOutput = z.object({
  text: z.string(),
  language_code: z.string().nullable().optional(),
  language_probability: z.number().nullable().optional(),
  words: z.array(ScribeWord),
});
type ScribeOutput = z.infer<typeof ScribeOutput>;

/** Scribe's response as Transcript@1: words keep their timings and speaker, audio events become events. */
export function scribeToTranscript(result: unknown, provider: string, model: string): Transcript {
  const out = ScribeOutput.parse(result);
  const words: Transcript["words"] = [];
  const events: Transcript["events"] = [];
  let last = 0;
  for (const w of out.words) {
    if (w.type === "spacing") continue;
    const start = Math.max(0, w.start ?? last);
    const end = Math.max(start, w.end ?? start);
    last = end;
    if (w.type === "audio_event") {
      events.push({ label: w.text.replace(/^[([]\s*|\s*[)\]]$/g, "").trim() || w.text, start_sec: start, end_sec: end });
    } else {
      words.push({ text: w.text, start_sec: start, end_sec: end, speaker: w.speaker_id ?? null });
    }
  }
  return { language: out.language_code ?? null, text: out.text.trim(), words, events, provider, model };
}

// ----- fal -----------------------------------------------------------------------

/** `keyFiles`: where to look for FAL_KEY after the environment (default: secrets.env, then the repository's .env). */
export function falTranscriber(projectDir: string, env: NodeJS.ProcessEnv = process.env, keyFiles?: string[]): Transcriber {
  let client: FalClient | undefined;
  const fal = (): FalClient => {
    // The key is passed to the client and nowhere else.
    client ??= createFalClient({ credentials: providerKey("FAL_KEY", projectDir, env, keyFiles) });
    return client;
  };
  return {
    name: "fal",
    ready() {
      fal();
    },
    async prepare(_endpoint, input) {
      const { audio_path, diarize, tag_audio_events } = input as TranscribeInput;
      const bytes = await readFile(audio_path);
      const file = new File([bytes], path.basename(audio_path), { type: mimeOf(audio_path) });
      const audio_url = await fal().storage.upload(file);
      return { audio_url, diarize, tag_audio_events };
    },
    async submit(endpoint, request) {
      try {
        const queued = await fal().queue.submit(endpoint, { input: request as Record<string, unknown> });
        return queued.request_id;
      } catch (error) {
        // A 4xx means fal refused it (bad input, auth, rate limit): nothing is billed.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          throw new SubmitRejected(`fal refused the request (HTTP ${error.status}): ${error.message}`);
        }
        throw error;
      }
    },
    async wait(endpoint, requestId, { timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const status = await fal().queue.status(endpoint, { requestId, logs: false });
        if (status.status === "COMPLETED") break;
        if (Date.now() > deadline) {
          throw new Error(`request ${requestId} still ${status.status} after ${Math.round(timeoutMs / 1000)}s`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      try {
        return (await fal().queue.result(endpoint, { requestId })).data;
      } catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
          throw new JobFailed(`HTTP ${error.status}: ${error.message}`);
        }
        throw error;
      }
    },
    model: (endpoint) => endpoint,
    toTranscript: (result, endpoint) => scribeToTranscript(result, "fal", endpoint),
  };
}

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".ogg": "audio/ogg" }[ext] ?? "application/octet-stream";
}

// ----- fake ----------------------------------------------------------------------

/** How a fake transcriber misbehaves, for tests. */
export interface FakeTranscriberOptions {
  /** Throw from this point. `submit-rejected` is a definite refusal; `submit-lost` an unanswered submit. */
  failAt?: "prepare" | "submit-rejected" | "submit-lost" | "job";
  /** Never finish waiting (until the wait times out). */
  hang?: boolean;
  /** Called on each submit, so a test can count them. */
  onSubmit?: (requestId: string) => void;
  /** Delay before submit returns, in ms, to widen races. */
  submitDelayMs?: number;
  /** Behave as if no key were configured. */
  noKey?: boolean;
}

const FAKE_WORDS = ["this", "changes", "everything", "about", "how", "you", "wash", "your", "car", "every", "single", "weekend"];

/** Deterministic, no network: a plausible Scribe-shaped result derived from the audio duration. */
export function fakeScribeResult(durationSec: number): ScribeOutput {
  const words: ScribeOutput["words"] = [];
  const eventEnd = Math.min(1, durationSec);
  words.push({ text: "(music)", start: 0, end: eventEnd, type: "audio_event", speaker_id: null });
  let t = eventEnd;
  let i = 0;
  while (t + 0.4 <= durationSec) {
    if (i > 0) words.push({ text: " ", start: t, end: t, type: "spacing", speaker_id: null });
    words.push({ text: FAKE_WORDS[i % FAKE_WORDS.length]!, start: t, end: t + 0.4, type: "word", speaker_id: i % 8 < 5 ? "speaker_0" : "speaker_1" });
    t += 0.5;
    i += 1;
  }
  const text = words.filter((w) => w.type !== "spacing").map((w) => w.text).join(" ");
  return { text, language_code: "eng", language_probability: 1, words };
}

export function fakeTranscriber(opts: FakeTranscriberOptions = {}): Transcriber {
  let submits = 0;
  return {
    name: "fake",
    ready() {
      if (opts.noKey) throw new MissingKeyError("fake transcriber told it has no key");
    },
    async prepare(_endpoint, input) {
      if (opts.failAt === "prepare") throw new Error("fake upload failed");
      const { audio_sha256, duration_sec, diarize, tag_audio_events } = input as TranscribeInput;
      return { audio_url: `fake://${audio_sha256}`, duration_sec, diarize, tag_audio_events };
    },
    async submit(_endpoint, request) {
      if (opts.submitDelayMs) await new Promise((r) => setTimeout(r, opts.submitDelayMs));
      if (opts.failAt === "submit-rejected") throw new SubmitRejected("fake provider refused the request");
      submits += 1;
      const { audio_url, duration_sec } = request as { audio_url: string; duration_sec: number };
      const requestId = `fake-${audio_url.slice(7, 19)}-${duration_sec}-${submits}`;
      opts.onSubmit?.(requestId);
      if (opts.failAt === "submit-lost") throw new Error("fake connection reset after sending");
      return requestId;
    },
    async wait(_endpoint, requestId, { timeoutMs }) {
      if (opts.hang) {
        await new Promise((r) => setTimeout(r, timeoutMs));
        throw new Error(`request ${requestId} still IN_PROGRESS after ${timeoutMs}ms`);
      }
      if (opts.failAt === "job") throw new JobFailed("fake job failed");
      const duration = Number(requestId.split("-")[2]);
      return fakeScribeResult(duration);
    },
    model: () => "fake-scribe",
    toTranscript: (result) => scribeToTranscript(result, "fake", "fake-scribe"),
  };
}

// ----- selection -----------------------------------------------------------------

let override: (() => Transcriber) | null = null;

/** Tests: use this transcriber instead of the configured one (null restores). */
export function useTranscriber(factory: (() => Transcriber) | null): void {
  override = factory;
}

/** `SOCIALV_TRANSCRIBER` (`fal` or `fake`) wins; otherwise fake under the fake runtime, else fal. */
export function selectTranscriber(projectDir: string, runtime: string, env: NodeJS.ProcessEnv = process.env): Transcriber {
  if (override) return override();
  const choice = env.SOCIALV_TRANSCRIBER ?? (runtime === "fake" || env.SOCIALV_RUNTIME === "fake" ? "fake" : "fal");
  if (choice === "fake") return fakeTranscriber();
  if (choice === "fal") return falTranscriber(projectDir, env);
  throw new Error(`SOCIALV_TRANSCRIBER must be "fal" or "fake", not "${choice}"`);
}

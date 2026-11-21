// Video generation providers behind one interface. `fal` is Seedance 2.5 on
// fal.ai; `fake` is deterministic and offline, for tests and the fake runtime.
//
// fal's schema, read 2026-11-21 from
// https://fal.ai/models/bytedance/seedance-2.5/reference-to-video/llms.txt
//   input:  prompt, task (default "reference"), image_urls[] (@Image1…),
//           video_urls[], audio_urls[] (@Audio1…, each 1.8 to 30.2 s),
//           resolution ("480p"|"720p"|"1080p"|"4k"), duration ("auto"|"4"…"30", a string),
//           aspect_ratio ("auto"|"21:9"|"16:9"|"4:3"|"1:1"|"3:4"|"9:16"),
//           generate_audio (default true), seed, bitrate_mode, codec, output_format
//   output: video { url }, seed
// and .../image-to-video/llms.txt: the same, with image_url (required) and
// end_image_url in place of the reference lists.

import { createFalClient, ApiError, type FalClient } from "@fal-ai/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Envelope } from "../schemas/render.ts";
import { JobFailed, SubmitRejected, type QueueProvider } from "./action.ts";
import { MissingKeyError, providerKey } from "./keys.ts";

export interface Renderer extends QueueProvider {
  /** Fetches the finished video. Provider URLs expire, so this happens at once. */
  download(url: string): Promise<Buffer>;
}

const LIST_FIELDS = new Set(["image_urls", "audio_urls"]);

/** The provider's request: the envelope's input plus one URL per file, in the envelope's order. */
export function requestFor(envelope: Envelope, urls: string[]): Record<string, unknown> {
  const request: Record<string, unknown> = { ...envelope.input };
  envelope.input_files.forEach((file, i) => {
    if (LIST_FIELDS.has(file.field)) {
      request[file.field] = [...((request[file.field] as string[] | undefined) ?? []), urls[i]!];
    } else {
      request[file.field] = urls[i]!;
    }
  });
  return request;
}

/** `projectDir` is where the envelope's file paths are relative to. */
export function falRenderer(projectDir: string, env: NodeJS.ProcessEnv = process.env, keyFiles?: string[]): Renderer {
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
      const envelope = input as Envelope;
      const urls: string[] = [];
      for (const file of envelope.input_files) {
        const bytes = await readFile(path.join(projectDir, file.path));
        urls.push(await fal().storage.upload(new File([bytes], path.basename(file.path), { type: mimeOf(file.path) })));
      }
      return requestFor(envelope, urls);
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
        await new Promise((r) => setTimeout(r, 5000));
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
    async download(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`could not download the video (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".wav": "audio/wav" }[ext] ??
    "application/octet-stream"
  );
}

// ----- fake ----------------------------------------------------------------------

export interface FakeRendererOptions {
  /** Called on each submit, so a test can count them. */
  onSubmit?: (request: Record<string, unknown>) => void;
  noKey?: boolean;
}

/** Deterministic, no network: a "video" whose bytes name the request. */
export function fakeRenderer(opts: FakeRendererOptions = {}): Renderer {
  let submits = 0;
  return {
    name: "fake",
    ready() {
      if (opts.noKey) throw new MissingKeyError("fake renderer told it has no key");
    },
    async prepare(_endpoint, input) {
      const envelope = input as Envelope;
      return requestFor(envelope, envelope.input_files.map((f) => `fake://${f.sha256}`));
    },
    async submit(_endpoint, request) {
      submits += 1;
      opts.onSubmit?.(request as Record<string, unknown>);
      return `fake-render-${submits}`;
    },
    async wait(_endpoint, requestId) {
      return { video: { url: `fake://video/${requestId}` }, seed: 7 };
    },
    async download(url) {
      return Buffer.from(`fake video from ${url}\n`);
    },
  };
}

// ----- selection -----------------------------------------------------------------

let override: (() => Renderer) | null = null;

/** Tests: use this renderer instead of the configured one (null restores). */
export function useRenderer(factory: (() => Renderer) | null): void {
  override = factory;
}

/** `SOCIALV_RENDERER` (`fal` or `fake`) wins; otherwise fake under the fake runtime, else fal. */
export function selectRenderer(projectDir: string, runtime: string, env: NodeJS.ProcessEnv = process.env): Renderer {
  if (override) return override();
  const choice = env.SOCIALV_RENDERER ?? (runtime === "fake" || env.SOCIALV_RUNTIME === "fake" ? "fake" : "fal");
  if (choice === "fake") return fakeRenderer();
  if (choice === "fal") return falRenderer(projectDir, env);
  throw new Error(`SOCIALV_RENDERER must be "fal" or "fake", not "${choice}"`);
}

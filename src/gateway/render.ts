// Operation `render`: one approved envelope in, one video take out, through
// the paid path. The envelope is the request: its digest is what the owner
// approved and what the ledger records.

import type { Board } from "openboardlol";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Envelope, Envelopes, type Take } from "../schemas/render.ts";
import { inside, readIfExists, sha256 } from "../step/files.ts";
import { GatewayRefusal, inputDigest, runPaidAction, type GatewayContext } from "./action.ts";
import { verifyApproval } from "./approval.ts";
import { estimate, type PriceBasis } from "./prices.ts";
import { selectRenderer } from "./renderers.ts";

export const RenderParams = z.object({
  op: z.literal("render"),
  /** The take's id in the plan. */
  take: z.string().min(1),
  /** The spend gate's stage name, where the approval is. */
  gate: z.string().min(1),
});

const Result = z.object({ video: z.object({ url: z.string().min(1) }), seed: z.number().nullable().optional() });

/** What the price table needs to know about an envelope's request. */
export function basisOf(input: Record<string, unknown>): PriceBasis {
  const duration = Number(input.duration);
  return {
    video_sec: Number.isFinite(duration) ? duration : undefined,
    resolution: typeof input.resolution === "string" ? input.resolution : undefined,
  };
}

/** Where a take's video goes, relative to the run folder. */
export function takeVideoPath(envelope: Pick<Envelope, "shot" | "plan" | "take">): string {
  return `renders/takes/${envelope.shot}/${envelope.plan}-${envelope.take}.mp4`;
}

export async function render(
  gw: GatewayContext,
  me: Board,
  envelopesValue: unknown,
  params: z.infer<typeof RenderParams>,
): Promise<{ value: Take; summary: string }> {
  const listed = Envelopes.parse(envelopesValue).envelopes.find((e) => e.take === params.take);
  if (!listed) throw new GatewayRefusal(`the plan's envelopes have no take ${params.take}`);
  const envelope = Envelope.parse(JSON.parse(await readFile(inside(gw.runDir, listed.path), "utf8")));
  const digest = inputDigest(envelope);
  if (envelope.action_id !== listed.action_id || envelope.run !== gw.run) {
    throw new GatewayRefusal(`envelope ${listed.path} is not the one listed for take ${params.take} of run ${gw.run}`);
  }

  // The files must be the ones that were shown and hashed.
  for (const file of envelope.input_files) {
    const bytes = await readFile(inside(gw.config.projectDir, file.path));
    if (sha256(bytes) !== file.sha256) {
      throw new GatewayRefusal(`${file.path} changed after the request was written; it needs a new approval`);
    }
  }
  // The approval covers at most the envelope's ceiling, whatever the price table says today.
  const basis = basisOf(envelope.input);
  const priced = estimate(envelope.endpoint, basis);
  if (priced.max_cost_usd > envelope.max_cost_usd + 1e-9) {
    throw new GatewayRefusal(
      `the request may now cost up to $${priced.max_cost_usd.toFixed(4)}, over the $${envelope.max_cost_usd.toFixed(4)} that was shown for approval`,
    );
  }

  const renderer = selectRenderer(gw.config.projectDir, gw.config.runtime);
  const outcome = await runPaidAction(gw, {
    operation: "render",
    actionId: envelope.action_id,
    endpoint: envelope.endpoint,
    input: envelope,
    basis,
    provider: renderer,
    approval: () => verifyApproval(me, gw.config, params.gate, envelope, digest),
  });

  const result = Result.parse(outcome.result);
  const video = takeVideoPath(envelope);
  const file = inside(gw.runDir, video);
  let bytes = outcome.replayed ? await readBytes(file) : null;
  if (!bytes) {
    bytes = await renderer.download(result.video.url);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, bytes);
    await rename(`${file}.tmp`, file);
  }
  const cost = outcome.row.actual_usd ?? outcome.row.estimated_usd;
  const value: Take = {
    action_id: envelope.action_id,
    plan: envelope.plan,
    take: envelope.take,
    shot: envelope.shot,
    label: envelope.label,
    endpoint: envelope.endpoint,
    video,
    sha256: sha256(bytes),
    bytes: bytes.length,
    seed: result.seed ?? null,
    request_id: outcome.row.request_id,
    cost_usd: cost,
  };
  const how = outcome.replayed ? "recorded result, " : "";
  return { value, summary: `rendered ${envelope.shot} take ${envelope.take}: ${video}, $${cost.toFixed(4)} (${how}request ${outcome.row.request_id})` };
}

async function readBytes(file: string): Promise<Buffer | null> {
  if ((await readIfExists(file)) === null) return null;
  return readFile(file);
}

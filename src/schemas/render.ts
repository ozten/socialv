// Rendering: the plan a person (later, an agent) writes, the envelope each
// paid request becomes (design 6.4), and the record of a finished take.

import { z } from "zod";

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** The request fields that carry files. Video inputs are not listed: they change the price and are not priced yet. */
export const FILE_FIELDS = ["image_urls", "audio_urls", "image_url", "end_image_url"] as const;

export const PlanFile = z
  .object({
    /** The request field the uploaded file's URL goes into. List fields keep the order given here. */
    field: z.enum(FILE_FIELDS),
    /** Relative to the project folder. */
    path: z.string().min(1),
  })
  .strict();

export const PlanTake = z
  .object({
    /** Short, unique in the plan: `a`, `refs-only`. */
    id: z.string().regex(NAME),
    shot: z.string().regex(/^shot_\d{2,}$/),
    /** What this take tries, for the person approving it. */
    label: z.string().min(1).max(200),
    endpoint: z.string().min(1),
    /** The provider's request fields, except the file fields. */
    input: z.record(z.unknown()),
    files: z.array(PlanFile).default([]),
  })
  .strict();
export type PlanTake = z.infer<typeof PlanTake>;

/** `renders/<name>/plan.json`: the takes one render job asks for. */
export const RenderPlan = z
  .object({
    v: z.literal(1),
    name: z.string().regex(NAME),
    takes: z.array(PlanTake).min(1).max(8),
  })
  .strict()
  .refine((plan) => new Set(plan.takes.map((t) => t.id)).size === plan.takes.length, "take ids must be unique");
export type RenderPlan = z.infer<typeof RenderPlan>;

/** One paid request, written to disk before the spend gate. Its digest is what an approval binds to. */
export const Envelope = z
  .object({
    v: z.literal(1),
    action_id: z.string().min(1),
    run: z.string().min(1),
    plan: z.string(),
    take: z.string(),
    shot: z.string(),
    label: z.string(),
    endpoint: z.string(),
    input: z.record(z.unknown()),
    input_files: z.array(
      z.object({ field: z.enum(FILE_FIELDS), path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number() }).strict(),
    ),
    est_cost_usd: z.number().nonnegative(),
    max_cost_usd: z.number().nonnegative(),
    expires_at: z.string(),
  })
  .strict();
export type Envelope = z.infer<typeof Envelope>;

/** `renders/<name>/envelopes.json`: the envelopes of a plan, numbered as the spend gate lists them. */
export const Envelopes = z
  .object({
    plan: z.string(),
    total_est_usd: z.number(),
    total_max_usd: z.number(),
    envelopes: z.array(
      z
        .object({
          n: z.number().int().positive(),
          action_id: z.string(),
          /** SHA-256 of the envelope's canonical JSON. */
          digest: z.string().regex(/^[0-9a-f]{64}$/),
          /** The envelope file, relative to the run folder. */
          path: z.string(),
          take: z.string(),
          shot: z.string(),
          label: z.string(),
          endpoint: z.string(),
          est_cost_usd: z.number(),
          max_cost_usd: z.number(),
        })
        .strict(),
    ),
  })
  .strict();
export type Envelopes = z.infer<typeof Envelopes>;

/** A rendered take: where the video is and what it cost. */
export const Take = z
  .object({
    action_id: z.string(),
    plan: z.string(),
    take: z.string(),
    shot: z.string(),
    label: z.string(),
    endpoint: z.string(),
    /** The video, relative to the run folder. */
    video: z.string(),
    sha256: z.string(),
    bytes: z.number(),
    seed: z.number().nullable(),
    request_id: z.string().nullable(),
    cost_usd: z.number(),
  })
  .strict();
export type Take = z.infer<typeof Take>;

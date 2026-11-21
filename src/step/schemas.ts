// Output schemas by the name a brief gives (`Name@version`). A plain map, not
// a registry service: Openboard's planned structured data will replace it.

import { z } from "zod";
import { Blueprint, Probe, ShotAnnotation, Shots, Transcript } from "../schemas/analysis.ts";
import { Envelopes, Take } from "../schemas/render.ts";

interface OutputSchema {
  schema: z.ZodTypeAny;
  /** For prompts: what the JSON looks like. */
  hint: string;
}

const SCHEMAS: Record<string, OutputSchema> = {
  "Text@1": {
    schema: z.object({ text: z.string().min(1) }).strict(),
    hint: 'Text@1, exactly {"text": "<string>"}',
  },
  "Probe@1": { schema: Probe, hint: "Probe@1: see src/schemas/analysis.ts" },
  "Transcript@1": { schema: Transcript, hint: "Transcript@1: see src/schemas/analysis.ts" },
  "Shots@1": { schema: Shots, hint: "Shots@1: see src/schemas/analysis.ts" },
  "ShotAnnotation@1": {
    schema: ShotAnnotation,
    hint:
      'ShotAnnotation@1, exactly {"shot_id": string, "purpose": string, "framing": string, "camera_motion": string, ' +
      '"subjects": string[], "action_beats": string[] (at least one, in order), "product_interaction": string or null, ' +
      '"environment": string, "on_screen_text": string[], "notes": string or null}',
  },
  "Blueprint@1": { schema: Blueprint, hint: "Blueprint@1: see src/schemas/analysis.ts" },
  "Envelopes@1": { schema: Envelopes, hint: "Envelopes@1: see src/schemas/render.ts" },
  "Take@1": { schema: Take, hint: "Take@1: see src/schemas/render.ts" },
};

export function getSchema(name: string): OutputSchema | undefined {
  return SCHEMAS[name];
}

/** Validates `value`; returns the parsed value or a readable list of errors. */
export function check(
  name: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; errors: string } {
  const entry = getSchema(name);
  if (!entry) {
    return { ok: false, errors: `unknown output schema ${name}` };
  }
  const result = entry.schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const errors = result.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
  return { ok: false, errors };
}

// Output schemas by the name a brief gives (`Name@version`). A plain map, not
// a registry service: Openboard's planned structured data will replace it.

import { z } from "zod";

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

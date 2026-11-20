// The template for tool roles: read inputs, compute, return a value. The
// step validates the value against the brief's schema, writes it atomically
// and settles the task. To add a tool role, copy this file and list it in
// `src/workers/registry.ts`.

import { z } from "zod";
import type { ToolRole } from "../types.ts";

const TextInput = z.object({ text: z.string() });

export const echo: ToolRole = {
  name: "echo",
  kind: "tool",
  async run({ brief, readInput }) {
    const op = brief.params.op;
    switch (op) {
      case "uppercase": {
        const { text } = TextInput.parse(await readInput(0));
        return { value: { text: text.toUpperCase() }, summary: "uppercased the input" };
      }
      case "stamp": {
        const { text } = TextInput.parse(await readInput(0));
        return { value: { text: `${text} — final` }, summary: "stamped the input final" };
      }
      default:
        throw new Error(`echo: unknown op ${JSON.stringify(op)} (expected "uppercase" or "stamp")`);
    }
  },
};

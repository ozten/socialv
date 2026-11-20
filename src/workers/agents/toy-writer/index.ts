import type { AgentRole } from "../../types.ts";
import { fake } from "./fake.ts";
import { DIRECTOR, systemPrompt, taskPrompt } from "./prompt.ts";

/** Toy agent role for M0: writes one sentence, after asking the director about tone. */
export const toyWriter: AgentRole = {
  name: "toy-writer",
  kind: "agent",
  model: "haiku",
  asks: [DIRECTOR],
  systemPrompt,
  taskPrompt,
  fake,
};

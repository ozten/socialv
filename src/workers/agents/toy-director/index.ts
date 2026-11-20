import type { AdvisoryRole } from "../../types.ts";
import { fake } from "./fake.ts";
import { mentionPrompt, systemPrompt } from "./prompt.ts";

/** Toy advisory role for M0: answers tone questions and keeps a decision log. */
export const toyDirector: AdvisoryRole = {
  name: "toy-director",
  kind: "advisory",
  model: "haiku",
  systemPrompt,
  mentionPrompt,
  fake,
};

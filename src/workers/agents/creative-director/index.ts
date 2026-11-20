import type { AdvisoryRole } from "../../types.ts";
import { fake } from "./fake.ts";
import { mentionPrompt, systemPrompt } from "./prompt.ts";

/**
 * The keeper of the brief's intent: answers questions by mention and keeps the
 * decision log. `sonnet`: rulings need judgment, and there are few of them.
 */
export const creativeDirector: AdvisoryRole = {
  name: "creative-director",
  kind: "advisory",
  model: "sonnet",
  systemPrompt,
  mentionPrompt,
  fake,
};

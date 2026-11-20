import type { AgentRole } from "../../types.ts";
import { fake } from "./fake.ts";
import { DIRECTOR, systemPrompt, taskPrompt } from "./prompt.ts";

/**
 * Describes one shot of the reference from its keyframes. `sonnet`: it must
 * read images well and follow a strict schema, and it runs once per shot, so
 * the larger model's cost and subscription share are not worth it here.
 */
export const annotator: AgentRole = {
  name: "annotator",
  kind: "agent",
  model: "sonnet",
  asks: [DIRECTOR],
  systemPrompt,
  taskPrompt,
  fake,
};

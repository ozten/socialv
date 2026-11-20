// The fake annotator: writes a valid annotation derived from the shot's data
// (its position, times, keyframes and words), with no model and no question.

import type { ShotAnnotation } from "../../../schemas/analysis.ts";
import type { FakeBehavior } from "../../types.ts";
import { writeJson } from "../fake-kit.ts";
import { sec, shotFacts } from "./shot.ts";

export const fake: FakeBehavior = async (ctx) => {
  if (ctx.kind !== "task") {
    throw new Error("annotator works tasks only");
  }
  const facts = shotFacts(ctx.runDir, ctx.brief);
  const purpose =
    facts.index === 1 ? "hook" : facts.index === facts.count ? "call to action" : `beat ${facts.index} of ${facts.count}`;
  const beats = facts.keyframes.map((k) => `frame at ${sec(k.timeSec)} (${k.reason})`);
  if (facts.words) beats.push(`someone says "${facts.words}"`);
  const annotation: ShotAnnotation = {
    shot_id: facts.shotId,
    purpose,
    framing: "medium shot, eye level",
    camera_motion: "static",
    subjects: [],
    action_beats: beats.length > 0 ? beats : [`${sec(facts.startSec)} to ${sec(facts.endSec)}: nothing extracted`],
    product_interaction: null,
    environment: "unknown (fake annotator)",
    on_screen_text: [],
    notes: ctx.brief.notes ? `Reworked: ${ctx.brief.notes}` : null,
  };
  await writeJson(ctx.draftPath, annotation);
  return `Described ${facts.shotId} (${purpose}).`;
};

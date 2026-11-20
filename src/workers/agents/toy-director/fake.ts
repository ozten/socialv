// The fake toy-director: answers with a fixed ruling, mentioning the asker,
// and appends it to the decision log, as the real agent is told to.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { FakeBehavior } from "../../types.ts";
import { fakeBoard, withoutMentions } from "../fake-kit.ts";

export const RULING = "warm and plain, no jargon";

export const fake: FakeBehavior = async (ctx, { env }) => {
  if (ctx.kind !== "mention") {
    throw new Error("toy-director answers mentions only");
  }
  const asker = ctx.mention.by.handle;
  await fakeBoard(env, ctx.role).reply(ctx.root.id, `@${asker} ${RULING}.`);
  await mkdir(path.dirname(ctx.decisionsPath), { recursive: true });
  const question = withoutMentions(ctx.mention.text).replace(/\s+/g, " ").slice(0, 120);
  await appendFile(ctx.decisionsPath, `- ${ctx.root.id}: ${question} -> ${RULING} (asked by ${asker})\n`);
  return `Ruled "${RULING}" for ${asker}.`;
};

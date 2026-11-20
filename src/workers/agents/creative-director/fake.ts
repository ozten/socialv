// The fake creative director: rules from the brief's first line, mentioning
// the asker, or, with no brief, refers the question to the owner; and appends
// the ruling to the decision log, as the real agent is told to.

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { FakeBehavior } from "../../types.ts";
import { ownerMention } from "../common.ts";
import { fakeBoard, withoutMentions } from "../fake-kit.ts";

export const REFERRED = "referred to the owner";

/** The ruling the fake gives for a brief: its first non-empty line, without heading marks. */
export function rulingFrom(brief: string): string {
  const line = brief.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  return `keep to the brief: ${line}`;
}

export const fake: FakeBehavior = async (ctx, { env }) => {
  if (ctx.kind !== "mention") {
    throw new Error("creative-director answers mentions only");
  }
  const asker = ctx.mention.by.handle;
  const question = withoutMentions(ctx.mention.text).replace(/\s+/g, " ").slice(0, 120);
  const me = fakeBoard(env, ctx.role);
  let ruling: string;
  if (ctx.projectBrief?.trim()) {
    ruling = rulingFrom(ctx.projectBrief);
    await me.reply(ctx.root.id, `@${asker} ${ruling}.`);
  } else {
    ruling = REFERRED;
    await me.reply(ctx.root.id, `${ownerMention(ctx.config)} The brief does not settle this; please decide: ${question}`);
  }
  await mkdir(path.dirname(ctx.decisionsPath), { recursive: true });
  await appendFile(ctx.decisionsPath, `- ${ctx.root.id}: ${question} -> ${ruling} (asked by ${asker})\n`);
  return `Ruled "${ruling}" for ${asker}.`;
};

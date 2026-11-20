import { z } from "zod";

/**
 * A task's brief: the machine-readable part of a task's root message. The
 * conductor writes it; `socialv step` reads it. Paths are relative to the
 * run folder.
 */
export const Brief = z.object({
  v: z.literal(1),
  run: z.string().min(1),
  stage: z.string().min(1),
  /** The role this task is kept for. Also the board profile that claims it. */
  role: z.string().min(1),
  shot: z.string().optional(),
  inputs: z.array(z.string()).default([]),
  /** Where the step writes its result. */
  output: z.string().min(1),
  /** Name and version of the output's schema, such as `ShotAnnotation@1`. */
  schema: z.string().min(1),
  /** Stage-specific settings. */
  params: z.record(z.unknown()).default({}),
  /** Notes from the owner on a rework. */
  notes: z.string().nullable().default(null),
});
export type Brief = z.infer<typeof Brief>;
export type BriefInput = z.input<typeof Brief>;

const FENCE = /```json\s*\n([\s\S]*?)\n```/;

/** The task text: a one-line summary for people, then the brief in a fenced JSON block. */
export function formatBrief(summary: string, brief: BriefInput): string {
  const parsed = Brief.parse(brief);
  return `${summary.trim()}\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n`;
}

/** Reads the brief out of a task's text. Throws if there is none or it is invalid. */
export function parseBrief(text: string): Brief {
  const match = FENCE.exec(text);
  if (!match?.[1]) {
    throw new Error("the task has no fenced JSON brief");
  }
  return Brief.parse(JSON.parse(match[1]));
}

/** The first line of a task's text: its summary for people. */
export function briefSummary(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

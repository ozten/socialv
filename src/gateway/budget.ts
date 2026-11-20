// Spending caps, from the `budget` key of the project's `socialv.json`, and
// the kill switch. Read on every action, so a change takes effect at once.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const Budget = z
  .object({
    /** Most a single run may spend. */
    run_usd: z.number().nonnegative().default(5),
    /** Most the whole project may spend in one UTC day, across runs. */
    day_usd: z.number().nonnegative().default(10),
    /** Largest action that needs no approval gate. */
    auto_approve_usd: z.number().nonnegative().default(0.5),
  })
  .strict();
export type Budget = z.infer<typeof Budget>;

/** The caps for a project. Conservative defaults for any that are absent. */
export function readBudget(projectDir: string): Budget {
  let text: string;
  try {
    text = readFileSync(path.join(projectDir, "socialv.json"), "utf8");
  } catch {
    return Budget.parse({});
  }
  const file = JSON.parse(text) as { budget?: unknown };
  const parsed = Budget.safeParse(file.budget ?? {});
  if (!parsed.success) {
    throw new Error(`socialv.json "budget" is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** The file whose existence stops all spending. */
export function stopSpendFile(projectDir: string): string {
  return path.join(projectDir, ".socialv", "stop-spend");
}

export function spendingStopped(projectDir: string): boolean {
  return existsSync(stopSpendFile(projectDir));
}

// `<runDir>/manifests/cost_log.csv`: one line per attempt, whatever its
// outcome (requirement G6). The ledger is the source of truth; this is the
// human-readable deliverable.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CostLogLine {
  run: string;
  task_id: string;
  action_id: string;
  operation: string;
  endpoint: string;
  /** What happened: refused, submitted, succeeded, failed, outcome_unknown, replayed, free. */
  event: string;
  request_id?: string | null;
  estimated_usd?: number | null;
  max_cost_usd?: number | null;
  actual_usd?: number | null;
  note?: string;
}

const COLUMNS = [
  "at", "run", "task_id", "action_id", "operation", "endpoint", "event",
  "request_id", "estimated_usd", "max_cost_usd", "actual_usd", "note",
] as const;

export function costLogPath(runDir: string): string {
  return path.join(runDir, "manifests", "cost_log.csv");
}

export function appendCostLog(runDir: string, line: CostLogLine): void {
  const file = costLogPath(runDir);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    // `wx`: only the first writer writes the header.
    writeFileSync(file, `${COLUMNS.join(",")}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const record: Record<string, unknown> = { at: new Date().toISOString(), ...line };
  appendFileSync(file, `${COLUMNS.map((c) => csv(record[c])).join(",")}\n`);
}

function csv(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = String(value).replace(/\r?\n/g, " ");
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

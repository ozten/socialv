// The gateway's ledger: one row per paid action, in SQLite.
//
// Two files, written in one transaction:
// - `<runDir>/ledger.db`: the run's record, every column (design 9).
// - `<projectDir>/.socialv/spend.db`: one small row per action of every run,
//   for the daily cap. It is ATTACHed to the run ledger, so the cap check and
//   the insert are one transaction across both files, and `BEGIN IMMEDIATE`
//   takes the write lock on both: two gateways (even for different runs)
//   cannot both pass the same remaining daily budget. Scanning every run's
//   ledger instead would need opening an unbounded set of files and would
//   give no lock across them, so two runs could overspend the day together.
//
// The journal stays in rollback mode (not WAL): SQLite only commits a
// transaction across attached files atomically in that mode.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Budget } from "./budget.ts";

export type ActionState = "consumed" | "submitted" | "succeeded" | "failed" | "outcome_unknown";

export interface ActionRow {
  action_id: string;
  run: string;
  task_id: string;
  operation: string;
  endpoint: string;
  input_digest: string;
  estimated_usd: number;
  max_cost_usd: number;
  state: ActionState;
  /** The board claim epoch that consumed the action. */
  epoch: number;
  request_id: string | null;
  actual_usd: number | null;
  /** Where the result was saved, relative to the run folder. */
  output_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewAction {
  action_id: string;
  run: string;
  task_id: string;
  operation: string;
  endpoint: string;
  input_digest: string;
  estimated_usd: number;
  max_cost_usd: number;
  epoch: number;
}

export type ConsumeResult =
  | { kind: "consumed"; row: ActionRow }
  | { kind: "existing"; row: ActionRow }
  | { kind: "over_cap"; cap: "run" | "day"; spent: number; limit: number };

const RUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (
  action_id     TEXT PRIMARY KEY,
  run           TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  operation     TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  input_digest  TEXT NOT NULL,
  estimated_usd REAL NOT NULL,
  max_cost_usd  REAL NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('consumed','submitted','succeeded','failed','outcome_unknown')),
  epoch         INTEGER NOT NULL,
  request_id    TEXT,
  actual_usd    REAL,
  output_path   TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);`;

const DAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS day.spend (
  action_id    TEXT NOT NULL,
  run          TEXT NOT NULL,
  day          TEXT NOT NULL,
  max_cost_usd REAL NOT NULL,
  state        TEXT NOT NULL,
  submitted    INTEGER NOT NULL DEFAULT 0,
  actual_usd   REAL,
  PRIMARY KEY (run, action_id)
);
CREATE INDEX IF NOT EXISTS day.spend_day ON spend (day);`;

/**
 * What a row counts against a cap: the actual cost once known, the ceiling
 * while it may still be billed, and nothing for an action that failed before
 * anything was sent.
 */
const COUNTED = `CASE
  WHEN actual_usd IS NOT NULL THEN actual_usd
  WHEN state = 'failed' AND NOT (%SUBMITTED%) THEN 0
  ELSE max_cost_usd END`;

export function ledgerPath(runDir: string): string {
  return path.join(runDir, "ledger.db");
}

export function dayLedgerPath(projectDir: string): string {
  return path.join(projectDir, ".socialv", "spend.db");
}

export class Ledger {
  readonly db: Database.Database;

  constructor(runDir: string, projectDir: string) {
    mkdirSync(runDir, { recursive: true });
    mkdirSync(path.dirname(dayLedgerPath(projectDir)), { recursive: true });
    this.db = new Database(ledgerPath(runDir));
    this.db.pragma("busy_timeout = 15000");
    this.db.prepare("ATTACH DATABASE ? AS day").run(dayLedgerPath(projectDir));
    this.db.exec(RUN_SCHEMA);
    this.db.exec(DAY_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  get(actionId: string): ActionRow | undefined {
    return this.db.prepare("SELECT * FROM actions WHERE action_id = ?").get(actionId) as ActionRow | undefined;
  }

  /** Committed spend of the run in this ledger. */
  runSpent(): number {
    const sql = `SELECT COALESCE(SUM(${COUNTED.replace("%SUBMITTED%", "request_id IS NOT NULL")}), 0) AS s FROM actions`;
    return (this.db.prepare(sql).get() as { s: number }).s;
  }

  /** Committed spend of the whole project on `day` (UTC, YYYY-MM-DD). */
  daySpent(day: string): number {
    const sql = `SELECT COALESCE(SUM(${COUNTED.replace("%SUBMITTED%", "submitted = 1")}), 0) AS s FROM day.spend WHERE day = ?`;
    return (this.db.prepare(sql).get(day) as { s: number }).s;
  }

  /**
   * Design 7 steps 3 and 4 in one transaction: if the action is already
   * recorded, return it; otherwise check the caps and record it `consumed`.
   */
  consume(action: NewAction, budget: Budget, now: Date = new Date()): ConsumeResult {
    const txn = this.db.transaction((): ConsumeResult => {
      const existing = this.get(action.action_id);
      // An action that failed before anything was sent cost nothing, so it may
      // be consumed again (a reopened task). Anything else is never resent.
      const retry = existing?.state === "failed" && existing.request_id === null;
      if (existing && !retry) {
        return { kind: "existing", row: existing };
      }
      const runSpent = this.runSpent();
      if (runSpent + action.max_cost_usd > budget.run_usd + 1e-9) {
        return { kind: "over_cap", cap: "run", spent: runSpent, limit: budget.run_usd };
      }
      const day = now.toISOString().slice(0, 10);
      const daySpent = this.daySpent(day);
      if (daySpent + action.max_cost_usd > budget.day_usd + 1e-9) {
        return { kind: "over_cap", cap: "day", spent: daySpent, limit: budget.day_usd };
      }
      const at = now.toISOString();
      if (retry) {
        this.db.prepare("DELETE FROM actions WHERE action_id = ?").run(action.action_id);
        this.db.prepare("DELETE FROM day.spend WHERE run = ? AND action_id = ?").run(action.run, action.action_id);
      }
      this.db
        .prepare(
          `INSERT INTO actions (action_id, run, task_id, operation, endpoint, input_digest, estimated_usd, max_cost_usd, state, epoch, created_at, updated_at)
           VALUES (@action_id, @run, @task_id, @operation, @endpoint, @input_digest, @estimated_usd, @max_cost_usd, 'consumed', @epoch, @at, @at)`,
        )
        .run({ ...action, at });
      this.db
        .prepare("INSERT INTO day.spend (action_id, run, day, max_cost_usd, state) VALUES (?, ?, ?, ?, 'consumed')")
        .run(action.action_id, action.run, day, action.max_cost_usd);
      return { kind: "consumed", row: this.get(action.action_id)! };
    });
    return txn.immediate();
  }

  /** Records the provider's request ID. Moves `consumed` to `submitted`; any other state is kept. */
  recordSubmitted(actionId: string, requestId: string): ActionRow {
    return this.update(actionId, () => {
      this.db
        .prepare(
          `UPDATE actions SET request_id = ?, state = CASE WHEN state = 'consumed' THEN 'submitted' ELSE state END, updated_at = ?
           WHERE action_id = ?`,
        )
        .run(requestId, new Date().toISOString(), actionId);
    });
  }

  recordSucceeded(actionId: string, actualUsd: number, outputPath: string): ActionRow {
    return this.update(actionId, () => {
      this.db
        .prepare("UPDATE actions SET state = 'succeeded', actual_usd = ?, output_path = ?, error = NULL, updated_at = ? WHERE action_id = ?")
        .run(actualUsd, outputPath, new Date().toISOString(), actionId);
    });
  }

  recordFailed(actionId: string, error: string): ActionRow {
    return this.setState(actionId, "failed", error);
  }

  recordUnknown(actionId: string, error: string): ActionRow {
    return this.setState(actionId, "outcome_unknown", error);
  }

  private setState(actionId: string, state: ActionState, error: string): ActionRow {
    return this.update(actionId, () => {
      this.db
        .prepare("UPDATE actions SET state = ?, error = ?, updated_at = ? WHERE action_id = ?")
        .run(state, error.slice(0, 2000), new Date().toISOString(), actionId);
    });
  }

  /** Runs `change` and mirrors the row into the day ledger, in one transaction. */
  private update(actionId: string, change: () => void): ActionRow {
    const txn = this.db.transaction(() => {
      change();
      const row = this.get(actionId);
      if (!row) {
        throw new Error(`ledger has no action ${actionId}`);
      }
      this.db
        .prepare("UPDATE day.spend SET state = ?, submitted = ?, actual_usd = ? WHERE run = ? AND action_id = ?")
        .run(row.state, row.request_id ? 1 : 0, row.actual_usd, row.run, row.action_id);
      return row;
    });
    return txn.immediate();
  }
}

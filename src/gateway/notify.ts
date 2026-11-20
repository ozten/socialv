// Where the gateway speaks: one line in the task's thread per submitted
// request (the human-readable record), and alerts in `alerts` that mention the
// owner. Every post carries an idempotency key, so a re-run does not repeat it.

import { createHash } from "node:crypto";
import { BoardError, type Board } from "openboardlol";
import { ALERTS } from "../channels.ts";

export interface Notifier {
  /** A line in the task's thread. */
  thread(text: string, key: string): Promise<void>;
  /** An alert in `alerts`. The text should already mention the owner. */
  ops(text: string, key: string): Promise<void>;
}

export function boardNotifier(me: Board, taskId: string): Notifier {
  return {
    thread: (text, key) => once(() => me.reply(taskId, { text, id: shortKey(key) })),
    ops: (text, key) => once(() => me.post(ALERTS, { text, id: shortKey(key) })),
  };
}

async function once(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    // The key was used before with other text: that message stands.
    if (!(error instanceof BoardError && error.code === "idempotency_conflict")) throw error;
  }
}

function shortKey(key: string): string {
  return key.length <= 200 ? key : `${key.slice(0, 120)}-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

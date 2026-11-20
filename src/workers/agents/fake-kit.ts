// Helpers for fake behaviours: the board as the role, and file writes. A fake
// does on the board what the real agent is told to do, with no model.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Board } from "openboardlol";
import { connect } from "../../board/connect.ts";
import { loadConfig } from "../../config.ts";

export function fakeBoard(env: NodeJS.ProcessEnv, role: string): Board {
  return connect(loadConfig(env), role, env);
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Text with its leading mentions taken off. */
export function withoutMentions(text: string): string {
  return text.replace(/^(\s*@\S+\s*)+/, "").trim();
}

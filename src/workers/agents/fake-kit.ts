// Helpers for fake behaviours: the board as the role, and file writes. A fake
// does on the board what the real agent is told to do, with no model.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { board, type Board } from "openboardlol";

export function fakeBoard(env: NodeJS.ProcessEnv, role: string): Board {
  return board({ url: env.BOARD_URL, name: env.BOARD_NAME, profile: role });
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Text with its leading mentions taken off. */
export function withoutMentions(text: string): string {
  return text.replace(/^(\s*@\S+\s*)+/, "").trim();
}

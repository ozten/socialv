import { board, type Board } from "openboardlol";
import type { Config } from "../config.ts";
import { resolveLogin } from "./login.ts";

/**
 * The board, acting as one of our profiles (`conductor`, a role), or as the
 * login itself with `null`. Works for a local board and a network board.
 */
export function connect(config: Config, profile: string | null, env: NodeJS.ProcessEnv = process.env): Board {
  const login = resolveLogin(config.boardUrl, env);
  return board({
    url: config.boardUrl,
    name: config.boardName,
    profile,
    token: login.token,
    fingerprint: login.fingerprint,
  });
}

/** True when the board answers us at `config.boardUrl`, with our login where it needs one. */
export async function boardAnswers(config: Config, timeoutMs = 3000): Promise<boolean> {
  try {
    const handle = connect(config, null);
    await Promise.race([
      handle.me(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return true;
  } catch (error) {
    // A missing login is a setup problem to report, not "no board".
    if (error instanceof Error && error.message.startsWith("no stored login")) throw error;
    return false;
  }
}

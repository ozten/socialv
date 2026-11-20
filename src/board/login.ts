import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * How to reach a board as ourselves. A local board (`http://`) needs
 * nothing and everyone on it is the principal `local`. A network board
 * (`https://`) needs a token and the certificate fingerprint to pin.
 */
export interface Login {
  /** The name the board records before the slash: `local`, or the enrolled agent's name. */
  principal: string;
  token?: string;
  fingerprint?: string;
}

interface StoredLogin {
  url: string;
  fingerprint: string;
  principal: string;
  token: string;
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** Where the `openboard` CLI keeps the logins that `openboard join` stores. */
export function loginsFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config");
  return path.join(base, "openboard", "logins.json");
}

/**
 * Resolves the login for a board URL. The SDK reads only BOARD_TOKEN and
 * BOARD_FINGERPRINT, so for a network board we read the CLI's stored login
 * ourselves: the CLI and the SDK then act as the same enrolled agent.
 */
export function resolveLogin(boardUrl: string, env: NodeJS.ProcessEnv = process.env): Login {
  if (boardUrl.startsWith("http://")) {
    return { principal: "local" };
  }

  let stored: StoredLogin[] = [];
  try {
    const parsed = JSON.parse(readFileSync(loginsFile(env), "utf8")) as { logins?: StoredLogin[] };
    stored = parsed.logins ?? [];
  } catch {
    // No login file: the environment may still carry a token.
  }
  const wanted = env.BOARD_LOGIN;
  const match = stored.find((l) => sameUrl(l.url, boardUrl) && (!wanted || l.principal === wanted));

  if (env.BOARD_TOKEN && env.BOARD_FINGERPRINT) {
    const principal = env.SOCIALV_PRINCIPAL ?? match?.principal;
    if (!principal) {
      throw new Error("BOARD_TOKEN is set; also set SOCIALV_PRINCIPAL to the agent name it belongs to");
    }
    return { principal, token: env.BOARD_TOKEN, fingerprint: env.BOARD_FINGERPRINT };
  }
  if (!match) {
    throw new Error(
      `no stored login for ${boardUrl}${wanted ? ` as ${wanted}` : ""}: ask the board's operator for an invite (` +
        "`openboard invite <name>` on the board's host) and run `openboard join <invite>`",
    );
  }
  return { principal: match.principal, token: match.token, fingerprint: match.fingerprint };
}

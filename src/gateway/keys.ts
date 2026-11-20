// Provider keys. Only the gateway reads them; every other process has them
// stripped from its environment (requirement G1). A key is never logged,
// posted or written anywhere by this code.

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Environment variables that hold credentials for paid providers. Stripped
 * from every worker child except the gateway's, and from every agent session.
 * Judge keys (Gemini) are not listed: judges call their model themselves
 * (design 4.4), so that decision belongs with the judge work.
 */
export const PROVIDER_KEY_VARS = [
  "FAL_KEY",
  "FAL_KEY_ID",
  "FAL_KEY_SECRET",
  "FAL_API_KEY",
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
  "REPLICATE_API_TOKEN",
] as const;

/** A copy of `env` without provider keys. */
export function withoutProviderKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of PROVIDER_KEY_VARS) {
    delete out[name];
  }
  return out;
}

/** The repository's own `.env`, resolved from this file, not the current directory. */
export const REPO_ENV_FILE = path.resolve(import.meta.dirname, "..", "..", ".env");

/** Where the owner puts keys for one project. The project folder is never committed. */
export function secretsFile(projectDir: string): string {
  return path.join(projectDir, "secrets.env");
}

export class MissingKeyError extends Error {}

/**
 * The value of `name`: from the environment, then `<projectDir>/secrets.env`,
 * then the repository's `.env`. Throws MissingKeyError naming the file to create.
 */
export function providerKey(
  name: string,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  files: string[] = [secretsFile(projectDir), REPO_ENV_FILE],
): string {
  const fromEnv = env[name]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  for (const file of files) {
    const value = readEnvFile(file)[name];
    if (value) {
      return value;
    }
  }
  throw new MissingKeyError(
    `no ${name} available to the gateway: create ${secretsFile(projectDir)} with a line \`${name}=<your key>\` ` +
      `(or set ${name} in the gateway's environment)`,
  );
}

/** Simple `KEY=value` lines; `#` comments, optional `export ` and quotes. Missing file: empty. */
function readEnvFile(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) out[match[1]!] = value;
  }
  return out;
}

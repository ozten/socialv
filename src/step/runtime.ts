// The agent runtime interface: one language-model session, started or
// resumed, that ends when the agent is done. `claude` is headless Claude
// Code under the owner's subscription; `fake` is deterministic, for tests.

import type { Config } from "../config.ts";
import type { AgentContext } from "../workers/types.ts";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
}

export interface RunInput {
  role: string;
  /** Model name or alias, such as `haiku`. */
  model: string;
  systemPrompt: string;
  prompt: string;
  /** The session's working directory. Resuming needs the same one. */
  cwd: string;
  /** Continue this saved session. */
  resumeSessionId?: string;
  /** Start a new session under this ID, so it can be recorded before it runs. */
  sessionId?: string;
  /** The session's whole environment. */
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** The same facts as the prompt, structured. Only the fake runtime reads it. */
  context: AgentContext;
}

export interface RunResult {
  sessionId: string;
  /** The session's final message. */
  text: string;
  usage?: Usage;
}

export interface AgentRuntime {
  run(input: RunInput): Promise<RunResult>;
}

/** Thrown when `resumeSessionId` names no saved session. */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`no saved session ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

/**
 * Variables a parent Claude Code session sets that would make a nested
 * `claude -p` think it is a child of that session (or use its messaging
 * socket). Auth and configuration variables are kept.
 */
const KEEP = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]);

/** The environment for an agent session acting as `role` on the board, built from `base`. */
export function sessionEnv(config: Config, role: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if ((key === "CLAUDECODE" || key.startsWith("CLAUDE_")) && !KEEP.has(key)) {
      delete env[key];
    }
  }
  // Agent roles run on the owner's subscription login, never an API key.
  delete env.ANTHROPIC_API_KEY;
  delete env.BOARD_PROFILE;
  delete env.BOARD_TOKEN;
  env.BOARD_URL = config.boardUrl;
  env.BOARD_NAME = config.boardName;
  env.BOARD_AS = role;
  // The agent runs `openboard wait --timeout 4m` once; the Bash tool's
  // default limit is 2 minutes.
  env.BASH_DEFAULT_TIMEOUT_MS = "300000";
  env.BASH_MAX_TIMEOUT_MS = "600000";
  return env;
}

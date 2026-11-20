// Headless Claude Code (`claude -p`) under the owner's subscription login.
// The session gets the `openboard` CLI through Bash and the file tools, and
// nothing else: no MCP servers, no user hooks or plugins.

import { spawn } from "node:child_process";
import { SessionNotFoundError, type AgentRuntime, type RunInput, type RunResult } from "./runtime.ts";

/** The tools an agent session may use, and the calls allowed without asking. */
const TOOLS = "Bash,Read,Write,Edit";
const ALLOWED = ["Bash(openboard:*)", "Read", "Write", "Edit"];

export function claudeArgs(input: RunInput): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    input.model,
    "--append-system-prompt",
    input.systemPrompt,
    "--tools",
    TOOLS,
    // Anything not allowed below is refused, not asked about.
    "--permission-mode",
    "dontAsk",
    // Leave out the owner's own MCP servers, hooks, plugins and CLAUDE.md.
    "--strict-mcp-config",
    "--safe-mode",
  ];
  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  } else if (input.sessionId) {
    args.push("--session-id", input.sessionId);
  }
  // Last: it takes every value after it.
  args.push("--allowedTools", ...ALLOWED);
  return args;
}

interface ClaudeJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export const claudeRuntime: AgentRuntime = {
  run(input) {
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn("claude", claudeArgs(input), {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const onAbort = () => child.kill("SIGTERM");
      input.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => {
        input.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (code) => {
        input.signal?.removeEventListener("abort", onAbort);
        if (input.resumeSessionId && /no conversation found/i.test(stderr + stdout)) {
          reject(new SessionNotFoundError(input.resumeSessionId));
          return;
        }
        let parsed: ClaudeJson;
        try {
          parsed = JSON.parse(stdout) as ClaudeJson;
        } catch {
          reject(new Error(`claude exited ${code} without a JSON result: ${(stderr || stdout).trim().slice(0, 500)}`));
          return;
        }
        if (parsed.is_error || code !== 0) {
          reject(new Error(`claude session failed (${parsed.subtype ?? code}): ${String(parsed.result ?? stderr).slice(0, 500)}`));
          return;
        }
        resolve({
          sessionId: parsed.session_id ?? input.resumeSessionId ?? input.sessionId ?? "",
          text: parsed.result ?? "",
          usage: {
            inputTokens: parsed.usage?.input_tokens,
            outputTokens: parsed.usage?.output_tokens,
            cacheReadTokens: parsed.usage?.cache_read_input_tokens,
            cacheCreationTokens: parsed.usage?.cache_creation_input_tokens,
            costUsd: parsed.total_cost_usd,
            turns: parsed.num_turns,
            durationMs: parsed.duration_ms,
          },
        });
      });
      child.stdin.end(input.prompt);
    });
  },
};

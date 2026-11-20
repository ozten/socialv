// The fake runtime: no model. It runs the role's fake behaviour, which acts
// on the board as the real agent would, and keeps a session log so tests can
// see which session ran and whether it was resumed.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getRole } from "../workers/registry.ts";
import { SessionNotFoundError, type AgentRuntime } from "./runtime.ts";

/** One line per session turn, in the session's working directory. */
export const FAKE_LOG = ".fake-sessions.jsonl";

export interface FakeLogEntry {
  role: string;
  sessionId: string;
  resumed: boolean;
  prompt: string;
}

export const fakeRuntime: AgentRuntime = {
  async run(input) {
    const role = getRole(input.role);
    if (!role || role.kind === "tool") {
      throw new Error(`no model role named ${input.role}`);
    }
    const log = path.join(input.cwd, FAKE_LOG);
    if (input.resumeSessionId) {
      const known = (await readFakeLog(input.cwd)).some((e) => e.sessionId === input.resumeSessionId);
      if (!known) {
        throw new SessionNotFoundError(input.resumeSessionId);
      }
    }
    const sessionId = input.resumeSessionId ?? input.sessionId ?? randomUUID();
    const entry: FakeLogEntry = { role: input.role, sessionId, resumed: Boolean(input.resumeSessionId), prompt: input.prompt };
    await mkdir(input.cwd, { recursive: true });
    await appendFile(log, `${JSON.stringify(entry)}\n`);
    const text = await role.fake(input.context, { env: input.env });
    return { sessionId, text, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 1 } };
  },
};

export async function readFakeLog(cwd: string): Promise<FakeLogEntry[]> {
  try {
    const text = await readFile(path.join(cwd, FAKE_LOG), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeLogEntry);
  } catch {
    return [];
  }
}

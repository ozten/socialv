// The mention loop for an advisory role: a long-poll on mentions of the role
// in `production/`, one model session per mention, nothing while idle. One session
// per run, resumed for each question so rulings stay consistent.

import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BoardError, type BoardEvent } from "openboardlol";
import { connect } from "../board/connect.ts";
import { runDir, type Config } from "../config.ts";
import { advisoryRoles, getRole } from "../workers/registry.ts";
import type { AdvisoryRole, MentionContext } from "../workers/types.ts";
import { readIfExists, writeAtomic } from "./files.ts";
import { SessionNotFoundError, sessionEnv, type RunResult } from "./runtime.ts";
import { selectRuntime } from "./select-runtime.ts";
import { recordUsage } from "./step.ts";

export interface MentionsOptions {
  signal?: AbortSignal;
  /** Called once the loop is listening: mentions from then on are not missed. */
  onReady?: () => void;
}

export async function runMentions(config: Config, role: string, opts: MentionsOptions = {}): Promise<void> {
  const def = getRole(role);
  if (!def || def.kind !== "advisory") {
    throw new Error(`${role} is not an advisory role`);
  }
  const { signal } = opts;
  const log = (message: string) => process.stderr.write(`socialv mentions ${role}: ${message}\n`);
  const me = connect(config, role);
  const query = { mentionsMe: true, notFromSelf: true, channel: "production/", types: ["message.posted", "message.edited"] };
  // The cursor is kept on disk, so a restart does not miss a question asked meanwhile.
  // A cursor belongs to one board, so the file is keyed by the board as well as the role.
  const boardKey = createHash("sha256").update(`${config.boardUrl}\n${config.boardName}`).digest("hex").slice(0, 12);
  const cursorFile = path.join(config.projectDir, ".socialv", `mentions-${role}-${boardKey}.cursor`);
  const handled = new Set<string>();
  let ready = false;
  let delay = 1000;

  while (!signal?.aborted) {
    try {
      let after = (await readIfExists(cursorFile))?.trim() || undefined;
      if (!after) {
        after = (await me.poll({ ...query, limit: 1 }, signal)).cursor;
        await writeAtomic(cursorFile, after);
      }
      if (!ready) {
        ready = true;
        opts.onReady?.();
      }
      for await (const event of me.events({ ...query, after }, { signal })) {
        delay = 1000;
        if (!handled.has(event.message_id)) {
          handled.add(event.message_id);
          await answer(config, def, event, signal).catch((error: unknown) => {
            if (!signal?.aborted) {
              log(`could not answer ${event.message_id}: ${error instanceof Error ? error.message : String(error)}`);
            }
          });
        }
        await writeAtomic(cursorFile, event.cursor);
      }
    } catch (error) {
      if (signal?.aborted) {
        break;
      }
      // A board that has never been posted to answers `not_found`; anything
      // else with a stored cursor may be a stale cursor, so start from now.
      if (error instanceof BoardError && error.code !== "not_found" && error.code !== "connection_failed") {
        await writeAtomic(cursorFile, "");
      }
      log(`${error instanceof Error ? error.message : String(error)}; retrying in ${delay / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

async function answer(config: Config, def: AdvisoryRole, event: BoardEvent, signal?: AbortSignal): Promise<void> {
  const role = def.name;
  const me = connect(config, role);
  const thread = await me.thread(event.thread_id);
  const mention = [thread.root, ...thread.replies].find((m) => m.id === event.message_id);
  if (!mention || mention.deleted_at || mention.by.profile === role) {
    return;
  }
  // A mention of the bare login (the owner on a local board) matches every
  // profile under it. Answer only when this role's own profile is named.
  if (!(mention.mentions ?? []).some((m) => m.profile === role)) {
    return;
  }
  // No chains: advisory roles do not wake each other.
  if (mention.by.profile && advisoryRoles().includes(mention.by.profile)) {
    process.stderr.write(`socialv mentions ${role}: ignored a mention from advisory role ${mention.by.profile}\n`);
    return;
  }
  const run = event.channel.split("/")[1];
  if (!run) {
    return;
  }
  const dir = runDir(config, run);
  await mkdir(dir, { recursive: true });
  const decisionsPath = path.join(dir, "creative", "decisions.md");
  const ctx: MentionContext = {
    kind: "mention",
    config,
    role,
    run,
    runDir: dir,
    root: thread.root,
    replies: thread.replies,
    mention,
    projectBrief: await readIfExists(path.join(config.projectDir, "brief.md")),
    decisionsPath,
    decisions: await readIfExists(decisionsPath),
  };

  const runtime = selectRuntime(config);
  const sessionFile = path.join(dir, "sessions", `${role}.json`);
  const saved = await readIfExists(sessionFile);
  const base = {
    role,
    model: def.model,
    systemPrompt: def.systemPrompt(config),
    prompt: def.mentionPrompt(ctx),
    cwd: dir,
    env: sessionEnv(config, role),
    signal,
    context: ctx,
  };
  const fresh = async (): Promise<RunResult> => {
    const sessionId = randomUUID();
    await writeAtomic(sessionFile, JSON.stringify({ sessionId }));
    return runtime.run({ ...base, sessionId });
  };
  let result: RunResult;
  if (saved) {
    const { sessionId } = JSON.parse(saved) as { sessionId: string };
    try {
      result = await runtime.run({ ...base, resumeSessionId: sessionId });
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) {
        throw error;
      }
      result = await fresh();
    }
  } else {
    result = await fresh();
  }
  await recordUsage(dir, { thread: thread.root.id, role, sessionId: result.sessionId, usage: result.usage });
  process.stderr.write(`socialv mentions ${role}: answered ${mention.by.handle} in ${thread.root.id}\n`);
}

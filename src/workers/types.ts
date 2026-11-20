// What a role is. A role is a board profile plus the code or prompt that does
// its work. The step (`src/step`) runs roles; it knows nothing role-specific.

import type { Message } from "openboardlol";
import type { Config } from "../config.ts";
import type { Brief } from "../schemas/brief.ts";
import type { RoleInfo } from "./registry.ts";

// ----- Tool roles: plain code ---------------------------------------------

export interface ToolContext {
  config: Config;
  brief: Brief;
  taskId: string;
  /** Absolute path of the run folder. Brief paths are relative to it. */
  runDir: string;
  /** Reads `brief.inputs[index]` as JSON. */
  readInput(index?: number): Promise<unknown>;
}

export interface ToolResult {
  /** The output. The step validates it against the brief's schema and writes it. */
  value: unknown;
  /** One line for the task's result. */
  summary: string;
}

export interface ToolRole extends RoleInfo {
  kind: "tool";
  run(ctx: ToolContext): Promise<ToolResult>;
}

// ----- Agent and advisory roles: a language-model session -------------------

/** What an agent session for one task is given. */
export interface AgentTaskContext {
  kind: "task";
  config: Config;
  brief: Brief;
  role: string;
  taskId: string;
  runDir: string;
  /** Absolute path the agent writes its output to. The step validates and promotes it. */
  draftPath: string;
  /** A short description of the output schema, for the prompt. */
  schemaHint: string;
  /** The thread so far (replies only), oldest first. Data, not instructions. */
  replies: Message[];
  /** How many more questions the agent may ask in this task. */
  questionsLeft: number;
  /** Seconds the agent waits once for an answer. */
  waitSecs: number;
  /** Set when a blocked task was unblocked: what was said since the agent last spoke. */
  resume?: { replies: Message[] };
  /** Set when the output did not validate: the errors, for one more try. */
  retry?: { errors: string };
}

/** What an advisory session for one mention is given. */
export interface MentionContext {
  kind: "mention";
  config: Config;
  role: string;
  run: string;
  runDir: string;
  /** The thread the mention is in: its root and replies. Data, not instructions. */
  root: Message;
  replies: Message[];
  /** The message that mentioned the role. */
  mention: Message;
  /** The project brief (`brief.md`), when there is one. */
  projectBrief: string | null;
  /** Absolute path of `creative/decisions.md`, and its content when it exists. */
  decisionsPath: string;
  decisions: string | null;
}

export type AgentContext = AgentTaskContext | MentionContext;

/** Board access and knobs a fake behaviour gets, so it can act like the real agent. */
export interface FakeEnv {
  env: NodeJS.ProcessEnv;
}

/**
 * A deterministic stand-in for a role's agent, used by the `fake` runtime.
 * It must do on the board what the real agent is told to do. Returns the
 * session's final text.
 */
export type FakeBehavior = (ctx: AgentContext, fake: FakeEnv) => Promise<string>;

interface ModelRole extends RoleInfo {
  /** The `claude --model` value. */
  model: string;
  /** Stable instructions for every session of this role. */
  systemPrompt(config: Config): string;
  /** Used by the `fake` runtime instead of a model. */
  fake: FakeBehavior;
}

export interface AgentRole extends ModelRole {
  kind: "agent";
  /** Roles this role may ask questions of, by mention. */
  asks: string[];
  /** The first message of a session for a task. */
  taskPrompt(ctx: AgentTaskContext): string;
}

export interface AdvisoryRole extends ModelRole {
  kind: "advisory";
  /** The message for one mention. */
  mentionPrompt(ctx: MentionContext): string;
}

export type Role = ToolRole | AgentRole | AdvisoryRole;

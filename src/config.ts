import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveLogin } from "./board/login.ts";

/** Settings every socialv process shares. All of them come from the environment. */
export interface Config {
  /** Where the board listens. */
  boardUrl: string;
  /** The board's name. One board per project. */
  boardName: string;
  /**
   * The name the board records for us, before the slash. `local` on a local
   * board; the enrolled agent's name on a network board. Every socialv
   * process posts under a profile of it, such as `socialv/conductor`.
   */
  principal: string;
  /**
   * The handle whose decisions are trusted. On a local board the web page
   * posts as the bare handle `local`. On a network board it is the owner's
   * email address, which the board verifies.
   */
  owner: string;
  /** Absolute path of the project folder (a user artifact, never committed). */
  projectDir: string;
  /** Where the review server is reached, for links in gate packets. */
  reviewUrl: string;
  /** Which agent runtime to use: `claude` (headless Claude Code) or `fake` (tests). */
  runtime: "claude" | "fake";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const projectDir = path.resolve(env.SOCIALV_PROJECT_DIR ?? "projects/demo");
  const file = readProjectFile(projectDir);
  const runtime = env.SOCIALV_RUNTIME ?? "claude";
  if (runtime !== "claude" && runtime !== "fake") {
    throw new Error(`SOCIALV_RUNTIME must be "claude" or "fake", not "${runtime}"`);
  }
  const boardUrl = env.BOARD_URL ?? file.boardUrl ?? "http://127.0.0.1:7878";
  const principal = resolveLogin(boardUrl, env).principal;
  const owner = env.SOCIALV_OWNER ?? file.owner ?? (principal === "local" ? "local" : undefined);
  if (!owner) {
    throw new Error(
      "on a network board the owner must be named: set `owner` in the project's socialv.json, or SOCIALV_OWNER, to the owner's email address",
    );
  }
  return {
    boardUrl,
    boardName: env.BOARD_NAME ?? file.boardName ?? path.basename(projectDir),
    principal,
    owner,
    projectDir,
    reviewUrl: env.SOCIALV_REVIEW_URL ?? "http://127.0.0.1:7979",
    runtime,
  };
}

/** The folder holding one run's artifacts. Paths in briefs are relative to it. */
export function runDir(config: Config, run: string): string {
  return path.join(config.projectDir, "runs", run);
}

/** The handle one of our profiles posts under: `local/echo`, or `socialv/echo`. */
export function handleOf(config: Config, profile: string): string {
  return `${config.principal}/${profile}`;
}

/**
 * Project settings, in `<projectDir>/socialv.json`. The project folder is a
 * user artifact, so this is where the board address and the owner's handle
 * live rather than in the repository. The environment overrides it.
 */
interface ProjectFile {
  boardUrl?: string;
  boardName?: string;
  owner?: string;
}

function readProjectFile(projectDir: string): ProjectFile {
  let text: string;
  try {
    text = readFileSync(path.join(projectDir, "socialv.json"), "utf8");
  } catch {
    return {};
  }
  return JSON.parse(text) as ProjectFile;
}

import path from "node:path";

/** Settings every socialv process shares. All of them come from the environment. */
export interface Config {
  /** Where the board listens. */
  boardUrl: string;
  /** The board's name. One board per project. */
  boardName: string;
  /**
   * The handle whose decisions are trusted. On a local board the web page
   * posts as the bare handle `local`; every socialv process posts under a
   * profile, such as `local/conductor`.
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
  const runtime = env.SOCIALV_RUNTIME ?? "claude";
  if (runtime !== "claude" && runtime !== "fake") {
    throw new Error(`SOCIALV_RUNTIME must be "claude" or "fake", not "${runtime}"`);
  }
  return {
    boardUrl: env.BOARD_URL ?? "http://127.0.0.1:7878",
    boardName: env.BOARD_NAME ?? path.basename(projectDir),
    owner: env.SOCIALV_OWNER ?? "local",
    projectDir,
    reviewUrl: env.SOCIALV_REVIEW_URL ?? "http://127.0.0.1:7979",
    runtime,
  };
}

/** The folder holding one run's artifacts. Paths in briefs are relative to it. */
export function runDir(config: Config, run: string): string {
  return path.join(config.projectDir, "runs", run);
}

/** The handle a profile posts under on a local board. */
export function localHandle(profile: string): string {
  return `local/${profile}`;
}

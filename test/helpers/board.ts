import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { board, type Board } from "openboardlol";

export interface TestBoard {
  url: string;
  name: string;
  /** A temporary project folder for this test. */
  projectDir: string;
  /** Environment for child processes that should talk to this board. */
  env: NodeJS.ProcessEnv;
  /** An SDK handle acting as `profile`, or as the bare owner handle with `null`. */
  as(profile: string | null): Board;
  stop(): Promise<void>;
}

/**
 * Starts a real local board on a free port, with its data and a project
 * folder in a temporary directory. Needs the `openboard` binary on PATH.
 */
export async function startBoard(name = "test"): Promise<TestBoard> {
  const root = await mkdtemp(path.join(tmpdir(), "socialv-test-"));
  const projectDir = path.join(root, "project");
  const child: ChildProcess = spawn(
    "openboard",
    ["serve", "--port", "0", "--json", "--data-dir", path.join(root, "board")],
    { stdio: ["ignore", "pipe", "inherit"] },
  );

  const url = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("the board did not start in 10s")), 10_000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the board exited early with code ${code}`)));
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /https?:\/\/[0-9.]+:\d+/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BOARD_URL: url,
    BOARD_NAME: name,
    SOCIALV_PROJECT_DIR: projectDir,
    SOCIALV_OWNER: "local",
    SOCIALV_RUNTIME: "fake",
  };
  delete env.BOARD_AS;
  delete env.BOARD_PROFILE;
  delete env.BOARD_TOKEN;

  return {
    url,
    name,
    projectDir,
    env,
    as: (profile) => board({ url, name, profile }),
    async stop() {
      child.removeAllListeners("exit");
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

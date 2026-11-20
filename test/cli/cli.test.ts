import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = path.resolve(import.meta.dirname, "..", "..", "bin", "socialv");
let projectDir: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "socialv-cli-"));
  env = { ...process.env, SOCIALV_PROJECT_DIR: projectDir, SOCIALV_RUNTIME: "fake" };
});
afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(BIN, args, { env, encoding: "utf8", timeout: 20_000 });
}

describe("socialv CLI", () => {
  it("prints help with --help", () => {
    const res = run("--help");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Usage: socialv <command>");
    for (const command of ["up", "conductor", "step", "worker", "mentions", "review"]) {
      expect(res.stdout).toContain(`  ${command} `);
    }
  });

  it.each(["up", "conductor", "step", "worker", "mentions", "review"])("prints help for %s", (command) => {
    const res = run(command, "--help");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`Usage: socialv ${command}`);
    expect(run("help", command).stdout).toBe(res.stdout);
  });

  it("exits 2 on an unknown command", () => {
    const res = run("frobnicate");
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(`unknown command "frobnicate"`);
  });

  it("exits 2 with no command", () => {
    expect(run().status).toBe(2);
  });

  it("exits 2 on a missing or unknown option", () => {
    expect(run("conductor").status).toBe(2);
    expect(run("worker").status).toBe(2);
    expect(run("review", "--bogus").status).toBe(2);
    expect(run("review", "--port", "nope").status).toBe(2);
    expect(run("step").status).toBe(2);
  });

  it("starts the review server with --port 0, serves, and exits 143 on SIGTERM", async () => {
    const child = spawn(BIN, ["review", "--port", "0"], { env, stdio: ["ignore", "pipe", "inherit"] });
    const url = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("no URL in 15s")), 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(buffer);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      child.once("exit", (code) => reject(new Error(`exited early with ${code}`)));
    });
    child.removeAllListeners("exit");

    const res = await fetch(`${url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<h1>Runs</h1>");

    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    child.kill("SIGTERM");
    expect(await exited).toBe(143);
  });
});

import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import { boardAnswers, runUp, Supervisor } from "../../src/up.ts";

let root: string;
let fakeBin: string;
let fakeOpenboard: string;

/** A stand-in for bin/socialv: every command logs, records its pid, and waits; the conductor exits 3. */
const FAKE_SOCIALV = `#!/bin/sh
dir="$(dirname "$0")"
case "$1" in
  conductor) echo "conducting $3"; sleep "\${FAKE_CONDUCTOR_SECONDS:-1}"; exit 3 ;;
  *) echo "$1 $3 up"; echo $$ >> "$dir/pids"; exec sleep 60 ;;
esac
`;

/** A stand-in for \`openboard serve --data-dir D --port P\`: answers /v1/health. */
const FAKE_OPENBOARD = `#!/usr/bin/env node
import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((req, res) => res.writeHead(req.url === "/v1/health" ? 200 : 404).end("{}"))
  .listen(port, "127.0.0.1", () => console.log("fake board on " + port));
process.on("SIGTERM", () => process.exit(143));
`;

function config(boardUrl: string): Config {
  return {
    boardUrl,
    boardName: "test",
    principal: "local",
    owner: "local",
    projectDir: path.join(root, "project"),
    reviewUrl: "http://127.0.0.1:7979",
    runtime: "fake",
  };
}

function healthServer(): Promise<Server> {
  const server = createServer((req, res) => res.writeHead(req.url === "/v1/health" ? 200 : 404).end("{}"));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pids(): Promise<number[]> {
  try {
    return (await readFile(path.join(root, "pids"), "utf8")).trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "socialv-up-"));
  fakeBin = path.join(root, "socialv");
  fakeOpenboard = path.join(root, "openboard.mjs");
  await writeFile(fakeBin, FAKE_SOCIALV);
  await writeFile(fakeOpenboard, FAKE_OPENBOARD);
  await chmod(fakeBin, 0o755);
  await chmod(fakeOpenboard, 0o755);
});
afterAll(async () => {
  for (const pid of await pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
  await rm(root, { recursive: true, force: true });
});

describe("Supervisor", () => {
  it("prefixes each line of output with the process name", async () => {
    const lines: string[] = [];
    const sup = new Supervisor({ out: (l) => lines.push(l) });
    const p = sup.start({ name: "echo", command: "sh", args: ["-c", "echo one; echo two >&2"], restart: false });
    expect(await p.done).toBe(0);
    await sup.stopAll();
    expect(lines).toContain("echo | one");
    expect(lines).toContain("echo | two");
  });

  it("restarts a process that exits unexpectedly, with backoff", async () => {
    const lines: string[] = [];
    const sup = new Supervisor({ out: (l) => lines.push(l), backoffMs: 20, maxBackoffMs: 80 });
    const p = sup.start({ name: "flaky", command: "sh", args: ["-c", "echo run; exit 1"], restart: true });
    await new Promise((r) => setTimeout(r, 600));
    expect(p.restarts).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => /restarting in 20 ms/.test(l))).toBe(true);
    expect(lines.some((l) => /restarting in 40 ms/.test(l))).toBe(true);
    await sup.stopAll();
    expect(await p.done).toBeTypeOf("number");
  });

  it("stops everything, including a child that ignores SIGTERM", async () => {
    const sup = new Supervisor({ out: () => {}, stopGraceMs: 200 });
    const a = sup.start({ name: "a", command: "sleep", args: ["60"], restart: true });
    const b = sup.start({ name: "b", command: "sh", args: ["-c", "trap '' TERM; sleep 60 & wait; sleep 60"], restart: true });
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await sup.stopAll();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await a.done).toBe(143);
    expect(await b.done).toBe(137);
  });

  it("reports a command that cannot start", async () => {
    const lines: string[] = [];
    const sup = new Supervisor({ out: (l) => lines.push(l) });
    const p = sup.start({ name: "nope", command: "/no/such/command", args: [], restart: true });
    expect(await p.done).toBe(127);
    expect(lines.some((l) => l.includes("could not start"))).toBe(true);
  });
});

describe("runUp", () => {
  it("uses a running board, starts roles and the conductor, exits with the conductor's code", async () => {
    const board = await healthServer();
    const { port } = board.address() as AddressInfo;
    const lines: string[] = [];
    try {
      const code = await runUp(config(`http://127.0.0.1:${port}`), {
        run: "demo-1",
        bin: fakeBin,
        roles: [
          { name: "probe", kind: "tool" },
          { name: "writer", kind: "agent" },
          { name: "director", kind: "advisory" },
        ],
        supervisor: { out: (l) => lines.push(l) },
      });
      expect(code).toBe(3);
      const text = lines.join("\n");
      expect(text).toMatch(/probe +\| worker probe up/);
      expect(text).toMatch(/writer +\| worker writer up/);
      expect(text).toMatch(/director +\| mentions director up/);
      expect(text).toMatch(/review +\| review {2}up/);
      expect(text).toMatch(/conductor +\| conducting demo-1/);
      expect(text).toContain("using the board already running");
      expect(text).toContain("http://127.0.0.1:7979/runs/demo-1/");
      expect(text).toContain("approvals/demo-1");
      // Everything it started is stopped; the board it found is left alone.
      for (const pid of await pids()) expect(alive(pid)).toBe(false);
      expect(await boardAnswers(`http://127.0.0.1:${port}`)).toBe(true);
    } finally {
      await new Promise((resolve) => board.close(resolve));
    }
  });

  it("starts a local board when none answers, and stops it on exit", async () => {
    const port = await freePort();
    const boardUrl = `http://127.0.0.1:${port}`;
    const lines: string[] = [];
    const code = await runUp(config(boardUrl), {
      run: "demo-2",
      bin: fakeBin,
      roles: [],
      openboard: fakeOpenboard,
      supervisor: { out: (l) => lines.push(l) },
    });
    expect(code).toBe(3);
    const text = lines.join("\n");
    expect(text).toContain(`starting a local board on port ${port}`);
    expect(text).toContain(path.join(root, "project", ".board"));
    expect(text).toMatch(/board +\| fake board on/);
    expect(await boardAnswers(boardUrl)).toBe(false);
  });

  it("stops everything and returns 130 when aborted with SIGINT", async () => {
    const board = await healthServer();
    const { port } = board.address() as AddressInfo;
    const controller = new AbortController();
    process.env.FAKE_CONDUCTOR_SECONDS = "60";
    try {
      const done = runUp(config(`http://127.0.0.1:${port}`), {
        run: "demo-3",
        bin: fakeBin,
        roles: [{ name: "probe", kind: "tool" }],
        signal: controller.signal,
        supervisor: { out: () => {} },
      });
      await new Promise((r) => setTimeout(r, 500));
      controller.abort("SIGINT");
      expect(await done).toBe(130);
      for (const pid of await pids()) expect(alive(pid)).toBe(false);
    } finally {
      delete process.env.FAKE_CONDUCTOR_SECONDS;
      await new Promise((resolve) => board.close(resolve));
    }
  });
});

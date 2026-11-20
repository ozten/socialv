import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runDir } from "../../src/config.ts";
import { runWorker } from "../../src/step/index.ts";
import { sha256 } from "../../src/step/files.ts";
import { startBoard, type TestBoard } from "../helpers/board.ts";
import { claimAndStep, configOf, createTask, taskOf, until, writeRunFile } from "./kit.ts";

let tb: TestBoard;
beforeAll(async () => {
  tb = await startBoard();
});
afterAll(() => tb.stop());

const output = (run: string, rel: string) => path.join(runDir(configOf(tb), run), rel);

test("echo uppercase writes the output and completes with its path and digest", async () => {
  await writeRunFile(tb, "r1", "in/a.json", { text: "hello" });
  const task = await createTask(tb, {
    run: "r1", stage: "upper", role: "echo", inputs: ["in/a.json"], output: "out/upper.json", schema: "Text@1",
    params: { op: "uppercase" },
  });
  const { code } = await claimAndStep(tb, "echo", task.id);
  expect(code).toBe(0);
  const content = await readFile(output("r1", "out/upper.json"), "utf8");
  expect(JSON.parse(content)).toEqual({ text: "HELLO" });
  const after = await taskOf(tb, task.id);
  expect(after.task?.state).toBe("completed");
  expect(after.task?.result).toBe(`uppercased the input\noutput: out/upper.json sha256:${sha256(content)}`);
});

test("echo stamp", async () => {
  await writeRunFile(tb, "r1", "in/b.json", { text: "draft" });
  const task = await createTask(tb, {
    run: "r1", stage: "stamp", role: "echo", inputs: ["in/b.json"], output: "out/stamp.json", schema: "Text@1",
    params: { op: "stamp" },
  });
  expect((await claimAndStep(tb, "echo", task.id)).code).toBe(0);
  expect(JSON.parse(await readFile(output("r1", "out/stamp.json"), "utf8"))).toEqual({ text: "draft — final" });
});

test("a brief for another role fails the task", async () => {
  // Kept for echo, but the brief names toy-writer.
  const { task } = await tb.as("conductor").tasks.create("work/r1", {
    text: "Wrong role\n\n```json\n" +
      JSON.stringify({ v: 1, run: "r1", stage: "x", role: "toy-writer", output: "out/x.json", schema: "Text@1" }) +
      "\n```\n",
    for: "echo",
  });
  expect((await claimAndStep(tb, "echo", task.id)).code).toBe(1);
  const after = await taskOf(tb, task.id);
  expect(after.task?.state).toBe("failed");
  expect(after.task?.reason).toMatch(/for role toy-writer, not echo/);
});

test("output that does not match the schema fails the task and writes nothing", async () => {
  await writeRunFile(tb, "r1", "in/c.json", { text: "x" });
  const task = await createTask(tb, {
    run: "r1", stage: "bad", role: "echo", inputs: ["in/c.json"], output: "out/bad.json", schema: "Count@1",
    params: { op: "uppercase" },
  });
  expect((await claimAndStep(tb, "echo", task.id)).code).toBe(1);
  expect((await taskOf(tb, task.id)).task?.reason).toMatch(/unknown output schema Count@1/);
  expect(existsSync(output("r1", "out/bad.json"))).toBe(false);
});

test("a step whose claim was lost settles nothing", async () => {
  await writeRunFile(tb, "r1", "in/d.json", { text: "late" });
  const task = await createTask(tb, {
    run: "r1", stage: "lost", role: "echo", inputs: ["in/d.json"], output: "out/lost.json", schema: "Text@1",
    params: { op: "uppercase" },
  });
  // A first claim whose lease runs out, then a second claim by another worker.
  // The shortest lease the board allows is 5 seconds.
  const first = await tb.as("echo").tasks.claim(task.id, { lease: 5 });
  await new Promise((r) => setTimeout(r, 5500));
  const second = await tb.as("echo").tasks.claim(task.id);
  expect(second.epoch).toBeGreaterThan(first.epoch);

  const { runStep } = await import("../../src/step/index.ts");
  const env = { ...tb.env, BOARD_TASK: task.id, BOARD_TASK_EPOCH: String(first.epoch), BOARD_TASK_TOKEN: first.token };
  expect(await runStep(configOf(tb), "echo", env)).toBe(1);
  const after = await taskOf(tb, task.id);
  expect(after.task?.state).toBe("claimed");
  expect(after.task?.epoch).toBe(second.epoch);
  expect(existsSync(output("r1", "out/lost.json"))).toBe(false);
  await tb.as("conductor").tasks.cancel(task.id, "test over");
});

test("the worker loop runs steps under the real `openboard tasks run`", async () => {
  await writeRunFile(tb, "r2", "in/a.json", { text: "pipeline" });
  const conductor = tb.as("conductor");
  const brief = (stage: string, op: string, inputs: string[], out: string) =>
    `${stage}\n\n\`\`\`json\n${JSON.stringify({ v: 1, run: "r2", stage, role: "echo", inputs, output: out, schema: "Text@1", params: { op }, notes: null })}\n\`\`\`\n`;
  const [upper, stamp] = await conductor.tasks.createMany("work/r2", [
    { key: "upper", text: brief("upper", "uppercase", ["in/a.json"], "out/upper.json"), for: "echo" },
    { key: "stamp", text: brief("stamp", "stamp", ["out/upper.json"], "out/final.json"), for: "echo", needs: [{ key: "upper" }] },
  ]);

  const controller = new AbortController();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tsx = path.resolve(here, "../../node_modules/.bin/tsx");
  const worker = runWorker(configOf(tb), "echo", {
    signal: controller.signal,
    command: [tsx, path.join(here, "step-entry.ts")],
  });
  try {
    await until("both tasks to complete", async () => {
      const states = await Promise.all([upper!, stamp!].map(async (t) => (await taskOf(tb, t.id)).task?.state));
      return states.every((s) => s === "completed");
    });
  } finally {
    controller.abort();
    await worker;
  }
  expect(JSON.parse(await readFile(output("r2", "out/final.json"), "utf8"))).toEqual({ text: "PIPELINE — final" });
});

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runDir } from "../../src/config.ts";
import { runMentions, SESSION_LABEL } from "../../src/step/index.ts";
import { readFakeLog } from "../../src/step/fake.ts";
import { RULING } from "../../src/workers/agents/toy-director/fake.ts";
import { startBoard, type TestBoard } from "../helpers/board.ts";
import { claimAndStep, configOf, createTask, taskOf, until } from "./kit.ts";

let tb: TestBoard;
beforeAll(async () => {
  tb = await startBoard();
});
afterAll(() => tb.stop());

const dirOf = (run: string) => runDir(configOf(tb), run);

function writerTask(run: string, extra: { notes?: string } = {}) {
  return createTask(tb, {
    run, stage: "draft", role: "toy-writer", output: "creative/draft.json", schema: "Text@1",
    params: { topic: "sparkling water" }, ...extra,
  }, "Draft one sentence");
}

/** Runs the director's mention loop for the duration of `fn`. */
async function withDirector<T>(fn: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => (ready = resolve));
  const loop = runMentions(configOf(tb), "toy-director", { signal: controller.signal, onReady: ready });
  await listening;
  try {
    return await fn();
  } finally {
    controller.abort();
    await loop;
  }
}

test("the writer asks the director, gets an answer in the thread, and completes using it", async () => {
  const task = await writerTask("c1");
  const { code } = await withDirector(() => claimAndStep(tb, "toy-writer", task.id));
  expect(code).toBe(0);

  const after = await taskOf(tb, task.id);
  expect(after.task?.state).toBe("completed");
  expect(after.task?.result).toMatch(/^Wrote a sentence about sparkling water\.\noutput: creative\/draft\.json sha256:[0-9a-f]{64}$/);
  const draft = JSON.parse(await readFile(path.join(dirOf("c1"), "creative/draft.json"), "utf8"));
  expect(draft.text).toContain(RULING);
  expect(existsSync(path.join(dirOf("c1"), "creative/draft.json.draft"))).toBe(false);

  const { replies } = await tb.as("conductor").thread(task.id);
  expect(replies.map((m) => [m.by.handle, m.text.split(" ")[0]])).toEqual([
    ["local/toy-writer", "@local/toy-director"],
    ["local/toy-director", "@local/toy-writer"],
  ]);
  const decisions = await readFile(path.join(dirOf("c1"), "creative/decisions.md"), "utf8");
  expect(decisions).toContain(`${task.id}: What tone`);
  expect(decisions).toContain(RULING);
  expect(after.labels?.[SESSION_LABEL]).toMatch(/^[0-9a-f-]{36}$/);
});

test("the director keeps one session per run and ignores its own mentions", async () => {
  const task = await writerTask("c2");
  await withDirector(async () => {
    await tb.as("toy-director").reply(task.id, "@local/toy-director note to self");
    await tb.as("toy-writer").reply(task.id, "@local/toy-director first?");
    await until("first answer", async () => (await tb.as("conductor").thread(task.id)).replies.length === 3);
    await tb.as("toy-writer").reply(task.id, "@local/toy-director second?");
    await until("second answer", async () => (await tb.as("conductor").thread(task.id)).replies.length === 5);
  });
  const sessions = (await readFakeLog(dirOf("c2"))).filter((e) => e.role === "toy-director");
  expect(sessions).toHaveLength(2);
  expect(sessions[0]!.resumed).toBe(false);
  expect(sessions[1]).toMatchObject({ resumed: true, sessionId: sessions[0]!.sessionId });
});

test("an unanswered question blocks the task; after a reply and unblock the next step resumes the same session", async () => {
  const task = await writerTask("c3");
  // No director listening, and a short wait: the writer times out and blocks.
  const first = await claimAndStep(tb, "toy-writer", task.id, { SOCIALV_FAKE_WAIT: "1" });
  expect(first.code).toBe(0);
  let state = await taskOf(tb, task.id);
  expect(state.task?.state).toBe("blocked");
  expect(state.task?.block_kind).toBe("needs_input");
  expect(state.task?.reason).toMatch(/What tone/);
  const sessionId = state.labels?.[SESSION_LABEL];
  expect(sessionId).toBeDefined();

  // The owner answers in the thread; the conductor unblocks.
  await tb.as(null).reply(task.id, "@local/toy-writer bold and cheeky");
  await tb.as("conductor").tasks.unblock(task.id);

  const second = await claimAndStep(tb, "toy-writer", task.id);
  expect(second.code).toBe(0);
  state = await taskOf(tb, task.id);
  expect(state.task?.state).toBe("completed");
  expect(state.labels?.[SESSION_LABEL]).toBe(sessionId);
  const draft = JSON.parse(await readFile(path.join(dirOf("c3"), "creative/draft.json"), "utf8"));
  expect(draft.text).toContain("bold and cheeky");

  const sessions = await readFakeLog(dirOf("c3"));
  expect(sessions.map((e) => [e.sessionId, e.resumed])).toEqual([[sessionId, false], [sessionId, true]]);
  expect(sessions[1]!.prompt).toContain("bold and cheeky");
});

test("a rework follows the owner's notes", async () => {
  const task = await writerTask("c4", { notes: "mention the bubbles" });
  expect((await withDirector(() => claimAndStep(tb, "toy-writer", task.id))).code).toBe(0);
  const draft = JSON.parse(await readFile(path.join(dirOf("c4"), "creative/draft.json"), "utf8"));
  expect(draft.text).toContain("mention the bubbles");
});

test("over the question budget, the task is blocked for the owner and no session starts", async () => {
  const task = await writerTask("c5");
  for (let i = 1; i <= 4; i += 1) {
    await tb.as("toy-writer").reply(task.id, `@local/toy-director question ${i}?`);
  }
  expect((await claimAndStep(tb, "toy-writer", task.id)).code).toBe(0);
  const state = await taskOf(tb, task.id);
  expect(state.task?.state).toBe("blocked");
  expect(state.task?.block_kind).toBe("needs_input");
  expect(state.task?.reason).toMatch(/Question budget spent/);
  expect(await readFakeLog(dirOf("c5"))).toEqual([]);
  const { replies } = await tb.as("conductor").thread(task.id);
  expect(replies.at(-1)?.mentions).toContainEqual(expect.objectContaining({ handle: "local" }));
});

test("agent output that does not validate gets one retry, then fails the task", async () => {
  const task = await writerTask("c6");
  const { code } = await withDirector(() => claimAndStep(tb, "toy-writer", task.id, { SOCIALV_FAKE_INVALID: "1" }));
  expect(code).toBe(1);
  const state = await taskOf(tb, task.id);
  expect(state.task?.state).toBe("failed");
  expect(state.task?.reason).toMatch(/does not match Text@1/);
  const sessions = (await readFakeLog(dirOf("c6"))).filter((e) => e.role === "toy-writer");
  expect(sessions.map((e) => e.resumed)).toEqual([false, true]);
  expect(existsSync(path.join(dirOf("c6"), "creative/draft.json"))).toBe(false);
});

test("a task canceled while the agent waits is left alone", async () => {
  const task = await writerTask("c7");
  const step = claimAndStep(tb, "toy-writer", task.id, { SOCIALV_FAKE_WAIT: "3" });
  await until("the question", async () => (await tb.as("conductor").thread(task.id)).replies.length === 1);
  await tb.as("conductor").tasks.cancel(task.id, "called off");
  expect((await step).code).toBe(1);
  const state = await taskOf(tb, task.id);
  expect(state.task?.state).toBe("canceled");
  expect(state.task?.reason).toBe("called off");
  expect(existsSync(path.join(dirOf("c7"), "creative/draft.json"))).toBe(false);
});

test("under the real `openboard tasks run`: a blocked step leaves the task blocked, and an answered one completes", async () => {
  const { fileURLToPath } = await import("node:url");
  const { runWorker } = await import("../../src/step/index.ts");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const command = [path.resolve(here, "../../node_modules/.bin/tsx"), path.join(here, "step-entry.ts")];

  // No director: the writer waits briefly, then blocks its task.
  process.env.SOCIALV_FAKE_WAIT = "1";
  const lonely = await writerTask("c8");
  let controller = new AbortController();
  let worker = runWorker(configOf(tb), "toy-writer", { signal: controller.signal, command });
  try {
    await until("the task to block", async () => (await taskOf(tb, lonely.id)).task?.state === "blocked");
  } finally {
    controller.abort();
    await worker;
    delete process.env.SOCIALV_FAKE_WAIT;
  }
  await tb.as("conductor").tasks.cancel(lonely.id, "test over");

  // With the director listening, the task completes.
  const task = await writerTask("c9");
  controller = new AbortController();
  worker = runWorker(configOf(tb), "toy-writer", { signal: controller.signal, command });
  try {
    await withDirector(() => until("the task to complete", async () => (await taskOf(tb, task.id)).task?.state === "completed"));
  } finally {
    controller.abort();
    await worker;
  }
  const draft = JSON.parse(await readFile(path.join(dirOf("c9"), "creative/draft.json"), "utf8"));
  expect(draft.text).toContain(RULING);
});

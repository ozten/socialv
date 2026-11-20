import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { runDir } from "../../src/config.ts";
import { actionIdFor } from "../../src/gateway/action.ts";
import { stopSpendFile } from "../../src/gateway/budget.ts";
import { costLogPath } from "../../src/gateway/cost-log.ts";
import { secretsFile } from "../../src/gateway/keys.ts";
import { ledgerPath } from "../../src/gateway/ledger.ts";
import { fakeTranscriber, falTranscriber, useTranscriber, type FakeTranscriberOptions } from "../../src/gateway/transcribers.ts";
import { Transcript } from "../../src/schemas/analysis.ts";
import { runWorker } from "../../src/step/index.ts";
import { sessionEnv } from "../../src/step/runtime.ts";
import { workerEnv } from "../../src/step/worker.ts";
import { gatewayTestOptions } from "../../src/workers/tools/gateway.ts";
import { startBoard, type TestBoard } from "../helpers/board.ts";
import { claimAndStep, configOf, createTask, taskOf, until } from "../step/kit.ts";
import { createSpendTask, ledgerRow, opsTexts, replyTexts, writeProbe } from "./kit.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.resolve(here, "../../node_modules/.bin/tsx");

let tb: TestBoard;
beforeAll(async () => {
  tb = await startBoard();
});
afterAll(() => tb.stop());

/** Request IDs the fake provider was asked to submit, in this test. */
let submits: string[] = [];
function useFake(opts: FakeTranscriberOptions = {}) {
  useTranscriber(() => fakeTranscriber({ ...opts, onSubmit: (id) => submits.push(id) }));
}

beforeEach(() => {
  submits = [];
  useFake();
});
afterEach(async () => {
  useTranscriber(null);
  gatewayTestOptions.hooks = undefined;
  gatewayTestOptions.waitTimeoutMs = undefined;
  await rm(path.join(tb.projectDir, "socialv.json"), { force: true });
  await rm(stopSpendFile(tb.projectDir), { force: true });
});

const file = (run: string, rel: string) => path.join(runDir(configOf(tb), run), rel);
const crash = () => {
  throw new Error("simulated crash");
};

async function setBudget(budget: Record<string, number>): Promise<void> {
  await mkdir(tb.projectDir, { recursive: true });
  await writeFile(path.join(tb.projectDir, "socialv.json"), JSON.stringify({ budget }));
}

/** Plays the conductor's reopen and a fresh claim, as after a crash or a failure. */
async function again(taskId: string) {
  await tb.as("conductor").tasks.reopen(taskId);
  return claimAndStep(tb, "gateway", taskId);
}

test("happy path: a claimed transcription task is paid for once, recorded and completed", async () => {
  await writeProbe(tb, "happy", 12);
  const task = await createSpendTask(tb, "happy");
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(0);

  const after = await taskOf(tb, task.id);
  expect(after.task?.state).toBe("completed");
  expect(after.task?.result).toMatch(/^transcribed 12\.0s of audio: \d+ words, 1 events, \$0\.0060/);

  const transcript = Transcript.parse(JSON.parse(await readFile(file("happy", "analysis/transcript.json"), "utf8")));
  expect(transcript.provider).toBe("fake");
  expect(transcript.events).toEqual([{ label: "music", start_sec: 0, end_sec: 1 }]);
  expect(transcript.words[0]).toEqual({ text: "this", start_sec: 1, end_sec: 1.4, speaker: "speaker_0" });
  expect(transcript.words.every((w) => w.end_sec >= w.start_sec)).toBe(true);

  const row = ledgerRow(tb, "happy", actionIdFor(task.id, "transcribe"))!;
  expect(row).toMatchObject({ state: "succeeded", request_id: submits[0], estimated_usd: 0.006, max_cost_usd: 0.03, actual_usd: 0.006 });
  expect(submits).toHaveLength(1);

  const log = await readFile(costLogPath(runDir(configOf(tb), "happy")), "utf8");
  const lines = log.trim().split("\n");
  expect(lines[0]).toBe("at,run,task_id,action_id,operation,endpoint,event,request_id,estimated_usd,max_cost_usd,actual_usd,note");
  expect(lines.slice(1).map((l) => l.split(",")[6])).toEqual(["submitted", "succeeded"]);

  const replies = await replyTexts(tb, task.id);
  expect(replies).toEqual([
    `Submitted transcribe to fal-ai/elevenlabs/speech-to-text: estimated $0.0060 (at most $0.0300), request ${submits[0]}`,
  ]);
});

test("the same task run twice submits once and returns the recorded result", async () => {
  await writeProbe(tb, "twice", 8);
  const task = await createSpendTask(tb, "twice");
  // The first run is paid for, then dies before it can settle the task.
  gatewayTestOptions.hooks = { afterSucceeded: crash };
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(1);
  expect(submits).toHaveLength(1);
  gatewayTestOptions.hooks = undefined;

  expect((await again(task.id)).code).toBe(0);
  expect(submits).toHaveLength(1);
  expect((await taskOf(tb, task.id)).task?.result).toMatch(/recorded result, request fake-/);
  const transcript = Transcript.parse(JSON.parse(await readFile(file("twice", "analysis/transcript.json"), "utf8")));
  expect(transcript.words.length).toBeGreaterThan(0);
  const log = await readFile(costLogPath(runDir(configOf(tb), "twice")), "utf8");
  expect(log).toMatch(/,replayed,/);
});

test("a crash after consume and before submit is outcome_unknown, alerted, failed, and never resubmitted", async () => {
  await writeProbe(tb, "lost", 10);
  const task = await createSpendTask(tb, "lost");
  const actionId = actionIdFor(task.id, "transcribe");
  gatewayTestOptions.hooks = { afterConsume: crash };
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(1);
  expect(ledgerRow(tb, "lost", actionId)?.state).toBe("consumed");
  gatewayTestOptions.hooks = undefined;

  // The next attempt (a new claim) finds it consumed with no request ID.
  expect((await again(task.id)).code).toBe(1);
  expect(ledgerRow(tb, "lost", actionId)?.state).toBe("outcome_unknown");
  const after = await taskOf(tb, task.id);
  expect(after.task?.state).toBe("failed");
  expect(after.task?.reason).toMatch(/outcome unknown .* not resubmitted/);
  const alerts = (await opsTexts(tb)).filter((t) => t.includes(actionId));
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatch(/^@local Paid action .* unknown outcome/);

  // A third attempt still does not submit.
  expect((await again(task.id)).code).toBe(1);
  expect(submits).toHaveLength(0);
  expect((await opsTexts(tb)).filter((t) => t.includes(actionId))).toHaveLength(1);
});

test("a crash after submit resumes the same request on the next run", async () => {
  await writeProbe(tb, "resume", 20);
  const task = await createSpendTask(tb, "resume");
  const actionId = actionIdFor(task.id, "transcribe");
  gatewayTestOptions.hooks = { afterSubmit: crash };
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(1);
  const submitted = ledgerRow(tb, "resume", actionId)!;
  expect(submitted.state).toBe("submitted");
  expect(submitted.request_id).toBe(submits[0]);
  gatewayTestOptions.hooks = undefined;

  expect((await again(task.id)).code).toBe(0);
  expect(submits).toHaveLength(1);
  expect(ledgerRow(tb, "resume", actionId)).toMatchObject({ state: "succeeded", request_id: submitted.request_id });
});

test("a request that hangs leaves the action submitted; the next run resumes it without resubmitting", async () => {
  await writeProbe(tb, "hang", 6);
  const task = await createSpendTask(tb, "hang");
  useFake({ hang: true });
  gatewayTestOptions.waitTimeoutMs = 200;
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(1);
  expect((await taskOf(tb, task.id)).task?.reason).toMatch(/still waiting on request fake-.*resumes it without resubmitting/);
  expect(ledgerRow(tb, "hang", actionIdFor(task.id, "transcribe"))?.state).toBe("submitted");

  useFake();
  expect((await again(task.id)).code).toBe(0);
  expect(submits).toHaveLength(1);
});

test("a request rejected by the provider fails, costs nothing, and may be retried by a reopen", async () => {
  await writeProbe(tb, "reject", 6);
  const task = await createSpendTask(tb, "reject");
  useFake({ failAt: "submit-rejected" });
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(1);
  const row = ledgerRow(tb, "reject", actionIdFor(task.id, "transcribe"))!;
  expect(row).toMatchObject({ state: "failed", request_id: null });

  useFake();
  expect((await again(task.id)).code).toBe(0);
  expect(submits).toHaveLength(1);
});

test("an action over the auto-approve threshold is refused: it needs a gate", async () => {
  await writeProbe(tb, "big", 3600); // an hour: up to $1.80
  const task = await createSpendTask(tb, "big");
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(1);
  expect((await taskOf(tb, task.id)).task?.reason).toMatch(/needs an approval gate \(not built yet\)/);
  expect(ledgerRow(tb, "big", actionIdFor(task.id, "transcribe"))).toBeUndefined();
  expect(submits).toHaveLength(0);
  expect(await readFile(costLogPath(runDir(configOf(tb), "big")), "utf8")).toMatch(/,refused,/);
});

test("the run cap refuses an action that would cross it, with an ops alert", async () => {
  // The first costs $0.015 and may cost up to $0.03; a second ceiling of $0.03 would pass $0.04.
  await setBudget({ run_usd: 0.04 });
  await writeProbe(tb, "runcap", 30);
  const first = await createSpendTask(tb, "runcap", { stage: "t1", output: "analysis/t1.json" });
  expect((await claimAndStep(tb, "gateway", first.id)).code).toBe(0);
  const second = await createSpendTask(tb, "runcap", { stage: "t2", output: "analysis/t2.json" });
  expect((await claimAndStep(tb, "gateway", second.id)).code).toBe(1);
  expect((await taskOf(tb, second.id)).task?.reason).toMatch(/would take run runcap over its cap/);
  expect(submits).toHaveLength(1);
  expect((await opsTexts(tb)).some((t) => t.startsWith("@local Spending cap reached") && t.includes(second.id))).toBe(true);
});

test("the day cap counts every run and refuses with an ops alert", async () => {
  await setBudget({ day_usd: 0.01 });
  await writeProbe(tb, "daycap", 5);
  const task = await createSpendTask(tb, "daycap");
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(1);
  expect((await taskOf(tb, task.id)).task?.reason).toMatch(/would take today \(UTC, all runs\) over its cap/);
  expect(submits).toHaveLength(0);
  expect((await opsTexts(tb)).some((t) => t.includes("Spending cap reached") && t.includes(task.id))).toBe(true);
});

test("the kill switch refuses everything", async () => {
  await mkdir(path.dirname(stopSpendFile(tb.projectDir)), { recursive: true });
  await writeFile(stopSpendFile(tb.projectDir), "");
  await writeProbe(tb, "killed", 5);
  const task = await createSpendTask(tb, "killed");
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(1);
  expect((await taskOf(tb, task.id)).task?.reason).toMatch(/spending is stopped/);
  expect(submits).toHaveLength(0);
});

test("an endpoint without a price is refused", async () => {
  await writeProbe(tb, "unpriced", 5);
  const task = await createSpendTask(tb, "unpriced", { params: { op: "transcribe", endpoint: "fal-ai/some/other-model" } });
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(1);
  expect((await taskOf(tb, task.id)).task?.reason).toMatch(/no price for endpoint fal-ai\/some\/other-model/);
  expect(submits).toHaveLength(0);
});

test("a probe with no audio gives an empty transcript at no cost, without the ledger", async () => {
  await writeProbe(tb, "silent", 9, false);
  const task = await createSpendTask(tb, "silent");
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(0);
  expect(JSON.parse(await readFile(file("silent", "analysis/transcript.json"), "utf8"))).toEqual({
    language: null, text: "", words: [], events: [], provider: "none", model: "none",
  });
  expect(existsSync(ledgerPath(runDir(configOf(tb), "silent")))).toBe(false);
  expect(submits).toHaveLength(0);
});

test("a missing key fails the task with the file to create, in process", async () => {
  useTranscriber(() => falTranscriber(tb.projectDir, {}, [secretsFile(tb.projectDir)]));
  await writeProbe(tb, "nokey", 5);
  const task = await createSpendTask(tb, "nokey");
  expect((await claimAndStep(tb, "gateway", task.id)).code).toBe(1);
  const reason = (await taskOf(tb, task.id)).task?.reason ?? "";
  expect(reason).toContain(`create ${secretsFile(tb.projectDir)} with a line \`FAL_KEY=<your key>\``);
  expect(ledgerRow(tb, "nokey", actionIdFor(task.id, "transcribe"))).toBeUndefined();
});

test("a missing key under the real worker loop fails that task and the loop goes on", async () => {
  await writeProbe(tb, "loop", 5);
  const paid = await createSpendTask(tb, "loop", { stage: "paid", output: "analysis/paid.json" });
  const controller = new AbortController();
  const worker = runWorker(configOf(tb), "gateway", { signal: controller.signal, command: [tsx, path.join(here, "gateway-entry.ts")] });
  try {
    await until("the paid task to fail", async () => (await taskOf(tb, paid.id)).task?.state === "failed");
    expect((await taskOf(tb, paid.id)).task?.reason).toMatch(/no FAL_KEY available to the gateway: create .*secrets\.env/);
    // The same loop then takes the next task.
    await writeProbe(tb, "loop2", 5, false);
    const free = await createSpendTask(tb, "loop2");
    await until("the next task to complete", async () => (await taskOf(tb, free.id)).task?.state === "completed");
  } finally {
    controller.abort();
    await worker;
  }
});

test("two gateways racing on one action submit it once", async () => {
  const run = runDir(configOf(tb), "race");
  await mkdir(run, { recursive: true });
  const submitsFile = path.join(run, "submits.txt");
  await writeFile(submitsFile, "");
  type Outcome = { ok: boolean; error?: string; replayed?: boolean };
  const race = (taskId: string, epochs: number[]) => {
    const startAt = String(Date.now() + 2500);
    return Promise.all(
      epochs.map(
        (epoch) =>
          new Promise<Outcome>((resolve, reject) => {
            const child = spawn(tsx, [path.join(here, "race-entry.ts"), run, tb.projectDir, taskId, String(epoch), submitsFile, startAt], {
              stdio: ["ignore", "pipe", "inherit"],
            });
            let out = "";
            child.stdout.on("data", (d: Buffer) => (out += d.toString()));
            child.once("error", reject);
            child.once("close", () => resolve(JSON.parse(out) as Outcome));
          }),
      ),
    );
  };
  /** Submits so far, across both races. */
  const submitted = async () => (await readFile(submitsFile, "utf8")).split("\n").filter(Boolean).length;

  // Two processes under the same claim: one submits and finishes; the other is told it is in progress.
  const same = await race("race-a", [1, 1]);
  expect(await submitted()).toBe(1);
  expect(same.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
  expect(same.find((r) => !r.ok)?.error).toMatch(/being submitted by another process under this claim/);

  // A stale claim and a newer one: the newer one cannot tell a slow submit from a crash,
  // so it marks the action unknown rather than resend. Still exactly one submit.
  const stale = await race("race-b", [1, 2]);
  expect(await submitted()).toBe(2);
  expect(stale.every((r) => r.ok || /outcome unknown|outcome_unknown/.test(r.error ?? ""))).toBe(true);
}, 30_000);

test("no worker but the gateway, and no agent session, gets a provider key", async () => {
  const config = configOf(tb);
  const base = { ...process.env, FAL_KEY: "not-a-real-key", OPENAI_API_KEY: "x", ELEVENLABS_API_KEY: "y" };
  for (const role of ["echo", "toy-writer", "toy-director"]) {
    const env = workerEnv(config, role, base);
    expect([env.FAL_KEY, env.OPENAI_API_KEY, env.ELEVENLABS_API_KEY]).toEqual([undefined, undefined, undefined]);
  }
  expect(workerEnv(config, "gateway", base).FAL_KEY).toBe("not-a-real-key");
  const session = sessionEnv(config, "toy-writer", base);
  expect([session.FAL_KEY, session.OPENAI_API_KEY, session.ELEVENLABS_API_KEY]).toEqual([undefined, undefined, undefined]);

  // And under the real loop: the step a worker starts sees no key, the gateway's does.
  const saved = process.env.FAL_KEY;
  process.env.FAL_KEY = "not-a-real-key";
  try {
    for (const [role, makeTask] of [
      ["echo", () => createTask(tb, { run: "envs", stage: "e", role: "echo", output: "out/e.json", schema: "Text@1", params: { op: "uppercase" } })],
      ["gateway", () => createSpendTask(tb, "envs")],
    ] as const) {
      const out = path.join(tb.projectDir, `env-${role}.json`);
      const task = await makeTask();
      const controller = new AbortController();
      const worker = runWorker(config, role, { signal: controller.signal, command: [process.execPath, path.join(here, "env-entry.mjs"), out] });
      try {
        await until(`the ${role} step to record its environment`, async () => existsSync(out));
      } finally {
        controller.abort();
        await worker;
      }
      const seen = JSON.parse(await readFile(out, "utf8")) as { keys: string[]; task: string };
      expect(seen.task).toBe(task.id);
      expect(seen.keys).toEqual(role === "gateway" ? ["FAL_KEY"] : []);
    }
  } finally {
    if (saved === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = saved;
  }
});

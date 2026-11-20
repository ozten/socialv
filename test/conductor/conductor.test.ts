import { readFile } from "node:fs/promises";
import path from "node:path";
import { board } from "openboardlol";
import { afterAll, beforeAll, expect, test } from "vitest";
import { OPS, statusChannel } from "../../src/channels.ts";
import { runDir } from "../../src/config.ts";
import { RunDriver } from "../../src/conductor/engine.ts";
import { runConductor } from "../../src/conductor/index.ts";
import { demoPipeline } from "../../src/conductor/pipelines/demo.ts";
import { parseBrief } from "../../src/schemas/brief.ts";
import { startBoard, type TestBoard } from "../helpers/board.ts";
import {
  gateBlocked,
  runTasks,
  startConductor,
  startWorkers,
  testConfig,
  threadsIn,
  waitFor,
} from "./helpers.ts";

let tb: TestBoard;
beforeAll(async () => {
  tb = await startBoard("conductor-test");
  // A board exists only after its first post; the helpers list before the conductor posts.
  await tb.as("observer").post("setup", "test board up");
});
afterAll(() => tb.stop());

const T = 40_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function conductorReplies(gateId: string) {
  const thread = await tb.as("observer").thread(gateId);
  return thread.replies.filter((r) => r.by.handle === "local/conductor");
}

test(
  "happy path: the run reaches the gate, the owner approves, finish runs, the run completes",
  async () => {
    const run = "happy";
    const workers = startWorkers(tb, run);
    const conductor = startConductor(tb, run);

    const gate = await gateBlocked(tb, run);
    const [packet, ...others] = await conductorReplies(gate.id);
    expect(others).toHaveLength(0);
    expect(packet!.text).toContain("@local ");
    expect(packet!.text).toContain("A TALE OF A LIGHTHOUSE KEEPER'S FIRST DAY OFF");
    expect(packet!.text).toContain("http://review.test/runs/happy/review/review-1.html");
    expect(packet!.text).toContain("`revise: <notes>`");
    expect(packet!.mentions?.some((m) => m.handle === "local")).toBe(true);
    // finish is not created before the gate is approved
    expect((await runTasks(tb, run)).find("finish")).toBeUndefined();
    // the review page was written into the run folder
    await readFile(path.join(runDir(testConfig(tb), run), "review", "review-1.html"), "utf8");

    await tb.as(null).reply(gate.id, "  Approve ");
    expect(await conductor.done).toBe("completed");

    const tasks = await runTasks(tb, run);
    const finish = tasks.find("finish")!;
    expect(finish.task?.state).toBe("completed");
    expect(finish.task?.assignee).toContain("echo");
    expect(finish.labels).toMatchObject({ run, stage: "finish", rev: "1" });
    expect(parseBrief(finish.text)).toMatchObject({ stage: "finish", role: "echo", inputs: ["out/shout.json"], params: { op: "stamp" } });
    expect(tasks.find("review")!.task?.state).toBe("completed");
    expect(tasks.find("review")!.task?.result).toMatch(/^approve\n/);
    const final = JSON.parse(await readFile(path.join(runDir(testConfig(tb), run), "out/final.json"), "utf8"));
    expect(final.text).toBe("A TALE OF A LIGHTHOUSE KEEPER'S FIRST DAY OFF [stamped]");

    const status = await threadsIn(tb, statusChannel(run));
    expect(status).toHaveLength(4); // started, gate opened, gate decided, completed
    expect(status.map((m) => m.text).join("\n")).toContain("completed");
    await workers.stop();
  },
  T,
);

test(
  "a decision from anyone but the owner is ignored; garbage from the owner gets one help reply",
  async () => {
    const run = "strangers";
    const workers = startWorkers(tb, run);
    const conductor = startConductor(tb, run);
    const gate = await gateBlocked(tb, run);

    await tb.as("toy-writer").reply(gate.id, "approve");
    await tb.as("conductor-impostor").reply(gate.id, "approve");
    await tb.as(null).reply(gate.id, "lgtm");
    const help = await waitFor("the help reply", async () => {
      const replies = await conductorReplies(gate.id);
      return replies.length >= 2 ? replies[1] : null;
    });
    expect(help.text).toContain("did not understand");
    expect(help.text).toContain("`approve 1,3`");

    await tb.as(null).reply(gate.id, "approve 2");
    await waitFor("the item-count reply", async () => (await conductorReplies(gate.id)).length >= 3);
    expect((await conductorReplies(gate.id))[2]!.text).toContain("has 1 item");

    await sleep(500);
    expect((await conductorReplies(gate.id)).length).toBe(3);
    const still = (await runTasks(tb, run)).find("review")!;
    expect(still.task?.state).toBe("blocked");
    expect((await runTasks(tb, run)).find("finish")).toBeUndefined();

    await tb.as(null).reply(gate.id, "approve 1");
    expect(await conductor.done).toBe("completed");
    expect((await runTasks(tb, run)).find("review")!.task?.result).toMatch(/^approve 1\napproved items: 1/);
    await workers.stop();
  },
  T,
);

test(
  "revise creates revision 2 with the notes and a new gate; reject ends the run",
  async () => {
    const run = "rework";
    const workers = startWorkers(tb, run);
    const conductor = startConductor(tb, run);
    const gate1 = await gateBlocked(tb, run, 1);

    await tb.as(null).reply(gate1.id, "revise: make it about cats");
    const gate2 = await gateBlocked(tb, run, 2);
    const tasks = await runTasks(tb, run);
    expect(tasks.find("review", 1)!.task?.state).toBe("canceled");
    expect(tasks.find("review", 1)!.task?.reason).toBe("revise: make it about cats");
    expect(parseBrief(tasks.find("draft", 2)!.text).notes).toBe("make it about cats");
    expect(parseBrief(tasks.find("shout", 2)!.text).notes).toBe("make it about cats");
    expect(tasks.find("shout", 2)!.task?.needs).toEqual([tasks.find("draft", 2)!.id]);
    expect(gate2.task?.needs).toEqual([tasks.find("shout", 2)!.id]);
    expect(tasks.work).toHaveLength(4);
    expect(tasks.gates).toHaveLength(2);
    const [packet] = await conductorReplies(gate2.id);
    expect(packet!.text).toContain("(MAKE IT ABOUT CATS)");
    expect(packet!.text).toContain("review-2.html");
    const receipt = (await conductorReplies(gate1.id)).at(-1)!;
    expect(receipt.text).toContain("revise: make it about cats");

    await tb.as(null).reply(gate2.id, "reject: not today");
    expect(await conductor.done).toBe("rejected");
    const after = await runTasks(tb, run);
    expect(after.find("review", 2)!.task?.state).toBe("canceled");
    expect(after.find("finish")).toBeUndefined();
    const status = (await threadsIn(tb, statusChannel(run))).map((m) => m.text).join("\n");
    expect(status).toContain("rejected at gate review (revision 2): not today");

    // Starting it again on a rejected run returns at once and changes nothing.
    const again = startConductor(tb, run);
    expect(await again.done).toBe("rejected");
    expect((await runTasks(tb, run)).work).toHaveLength(4);
    await workers.stop();
  },
  T,
);

test(
  "a restarted conductor duplicates nothing, before and after the gate opens",
  async () => {
    const run = "restart";
    // Before the gate opens: no workers, so the run stops at draft.
    const first = startConductor(tb, run);
    await waitFor("draft", async () => (await runTasks(tb, run)).find("draft"));
    await sleep(300);
    expect(await first.stop()).toBe("aborted");

    const workers = startWorkers(tb, run);
    const second = startConductor(tb, run);
    const gate = await gateBlocked(tb, run);
    expect(await second.stop()).toBe("aborted");

    // After the gate opened.
    const third = startConductor(tb, run);
    await sleep(1000);
    let tasks = await runTasks(tb, run);
    expect(tasks.work).toHaveLength(2);
    expect(tasks.gates).toHaveLength(1);
    expect(await conductorReplies(gate.id)).toHaveLength(1);
    expect(await threadsIn(tb, statusChannel(run))).toHaveLength(2);

    await tb.as(null).reply(gate.id, "approve");
    expect(await third.done).toBe("completed");

    // And once more after it finished.
    expect(await startConductor(tb, run).done).toBe("completed");
    tasks = await runTasks(tb, run);
    expect(tasks.work).toHaveLength(3);
    expect(tasks.gates).toHaveLength(1);
    expect(await conductorReplies(gate.id)).toHaveLength(2); // packet, receipt
    expect(await threadsIn(tb, statusChannel(run))).toHaveLength(4);
    await workers.stop();
  },
  T,
);

test(
  "a conductor killed over and over still converges without duplicates",
  async () => {
    const run = "flaky";
    const workers = startWorkers(tb, run);
    let decided = false;
    for (let i = 0; i < 40; i++) {
      const conductor = startConductor(tb, run);
      await sleep(50 + ((i * 37) % 200));
      const outcome = await conductor.stop();
      if (outcome === "completed") break;
      const gate = (await runTasks(tb, run)).find("review");
      if (!decided && gate?.task?.state === "blocked") {
        await tb.as(null).reply(gate.id, "approve");
        decided = true;
      }
    }
    expect(await startConductor(tb, run).done).toBe("completed");
    const tasks = await runTasks(tb, run);
    expect(tasks.work).toHaveLength(3);
    expect(tasks.gates).toHaveLength(1);
    expect(await conductorReplies(tasks.find("review")!.id)).toHaveLength(2);
    expect(await threadsIn(tb, statusChannel(run))).toHaveLength(4);
    await workers.stop();
  },
  60_000,
);

test(
  "a work task blocked on a question is unblocked when someone else answers in its thread",
  async () => {
    const run = "question";
    let asked = 0;
    const workers = startWorkers(tb, run, {
      "toy-writer": async (claim) => {
        if (asked >= 2) return;
        asked += 1;
        await tb.as("toy-writer").reply(claim.id, `@local/echo question ${asked}: how loud?`);
        await claim.block(`question ${asked}`, { kind: "needs_input" });
        return "handled";
      },
    });
    const conductor = startConductor(tb, run);
    const blocked = (n: number) =>
      waitFor(`draft blocked on question ${n}`, async () => {
        const draft = (await runTasks(tb, run)).find("draft");
        return draft?.task?.state === "blocked" && draft.task.reason === `question ${n}` ? draft : null;
      });

    const draft = await blocked(1);
    // The role itself talking does not count as an answer.
    await tb.as("toy-writer").reply(draft.id, "still waiting");
    await sleep(500);
    expect((await runTasks(tb, run)).find("draft")!.task?.state).toBe("blocked");
    await tb.as("echo").reply(draft.id, "very loud");
    await blocked(2);

    // The answer arrives while the conductor is down.
    expect(await conductor.stop()).toBe("aborted");
    await tb.as(null).reply(draft.id, "as loud as you like");
    const restarted = startConductor(tb, run);
    await gateBlocked(tb, run);
    expect(asked).toBe(2);
    expect(await restarted.stop()).toBe("aborted");
    await workers.stop();
  },
  T,
);

test(
  "a failed task is reopened twice, then the owner is told in ops",
  async () => {
    const run = "failing";
    let failures = 0;
    const workers = startWorkers(tb, run, {
      "toy-writer": async (claim) => {
        failures += 1;
        await claim.fail(`boom ${failures}`);
        return "handled";
      },
    });
    const conductor = startConductor(tb, run);
    const alert = await waitFor("the ops alert", async () =>
      (await threadsIn(tb, OPS)).find((m) => m.text.includes(`run ${run}`)),
    );
    expect(alert.text).toContain("@local ");
    expect(alert.text).toContain("boom 3");
    expect(alert.mentions?.some((m) => m.handle === "local")).toBe(true);
    const draft = (await runTasks(tb, run)).find("draft")!;
    expect(draft.task?.state).toBe("failed");
    expect(draft.labels?.attempts).toBe("2");
    expect(failures).toBe(3);

    // Restarting does not reopen it again or alert twice.
    expect(await conductor.stop()).toBe("aborted");
    const again = startConductor(tb, run);
    await sleep(800);
    expect(failures).toBe(3);
    expect((await threadsIn(tb, OPS)).filter((m) => m.text.includes(`run ${run}`))).toHaveLength(1);
    expect(await again.stop()).toBe("aborted");
    await workers.stop();
  },
  T,
);

test(
  "a conductor that dies at any write, before or after the board took it, duplicates nothing",
  async () => {
    const run = "crashy";
    const workers = startWorkers(tb, run);
    const config = testConfig(tb);
    let decided = false;
    let outcome: string | null = null;
    // Life n dies at its (n/2)th write: before sending it on even n, after the
    // board answered on odd n, so both "never sent" and "sent, answer lost" occur.
    for (let life = 0; life < 400 && !outcome; life++) {
      let writes = 0;
      const limit = Math.floor(life / 2) + 1;
      const lostAnswer = life % 2 === 1;
      const handle = board({
        url: tb.url,
        name: tb.name,
        profile: "conductor",
        fetch: async (url, init) => {
          if (init.method === "GET") return fetch(url, init);
          writes += 1;
          if (writes < limit) return fetch(url, init);
          if (lostAnswer) await fetch(url, init);
          throw new Error(`crash at write ${writes}`);
        },
      });
      const driver = new RunDriver(config, run, demoPipeline(), handle, { log: () => {} });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 700);
      try {
        const result = await driver.drive(controller.signal);
        if (result !== "aborted") outcome = result;
      } catch (error) {
        expect(String(error)).toContain("crash at write");
      } finally {
        clearTimeout(timer);
      }
      const gate = (await runTasks(tb, run)).find("review");
      if (!decided && gate?.task?.state === "blocked") {
        await tb.as(null).reply(gate.id, "approve");
        decided = true;
      }
    }
    expect(outcome).toBe("completed");
    const tasks = await runTasks(tb, run);
    expect(tasks.work).toHaveLength(3);
    expect(tasks.gates).toHaveLength(1);
    expect(await conductorReplies(tasks.find("review")!.id)).toHaveLength(2);
    expect(await threadsIn(tb, statusChannel(run))).toHaveLength(4);
    await workers.stop();
  },
  120_000,
);

test(
  "on revise, an unfinished task that needs a reworked stage is re-pointed, not recreated",
  async () => {
    const run = "repoint";
    const base = demoPipeline();
    const side = {
      kind: "stage" as const,
      name: "side",
      role: "nobody", // no worker: it stays open
      needs: ["shout"],
      summary: "Wait on the shout.",
      inputs: ["out/shout.json"],
      output: "out/side.json",
      schema: "Text@1",
      params: {},
    };
    const pipeline = { name: "demo-side", nodes: [...base.nodes.slice(0, 2), side, ...base.nodes.slice(2)] };
    const workers = startWorkers(tb, run);
    const controller = new AbortController();
    const done = runConductor(testConfig(tb), { run, signal: controller.signal, pipeline, log: () => {} });

    const gate1 = await gateBlocked(tb, run, 1);
    const before = (await runTasks(tb, run)).find("side")!;
    expect(before.task?.state).toBe("ready");
    await tb.as(null).reply(gate1.id, "revise: again");
    await gateBlocked(tb, run, 2);
    const tasks = await runTasks(tb, run);
    const after = tasks.find("side")!;
    expect(after.id).toBe(before.id);
    expect(tasks.find("side", 2)).toBeUndefined();
    expect(after.task?.needs).toEqual([tasks.find("shout", 2)!.id]);
    controller.abort();
    expect(await done).toBe("aborted");
    await workers.stop();
  },
  T,
);

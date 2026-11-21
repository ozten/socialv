import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { board, type Message } from "openboardlol";
import { afterAll, beforeAll, expect, test } from "vitest";
import { gatesChannel, spendChannel, statusChannel, workChannel } from "../../src/channels.ts";
import { runDir } from "../../src/config.ts";
import { RunDriver } from "../../src/conductor/engine.ts";
import { runConductor } from "../../src/conductor/index.ts";
import { analysisPipeline } from "../../src/conductor/pipelines/analysis.ts";
import { parseBrief } from "../../src/schemas/brief.ts";
import { startBoard, type TestBoard } from "../helpers/board.ts";
import { shotId, startAnalysisWorker, startAnalysisWorkers } from "./analysis-kit.ts";
import { tasksIn, testConfig, threadsIn, waitFor, type Behavior } from "./helpers.ts";

let tb: TestBoard;
beforeAll(async () => {
  tb = await startBoard("analysis-test");
  await tb.as("observer").post("setup", "test board up");
});
afterAll(() => tb.stop());

const T = 60_000;
const GATE = "blueprint-review";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = process.env.DEBUG ? undefined : () => {};

function start(run: string, opts: { pipeline?: string; params?: Record<string, unknown> } = { pipeline: "analysis" }) {
  const controller = new AbortController();
  const done = runConductor(testConfig(tb), { run, ...opts, signal: controller.signal, log: quiet });
  return {
    done,
    stop() {
      controller.abort();
      return done;
    },
  };
}

async function tasksOf(run: string) {
  const work = await tasksIn(tb, workChannel(run));
  const spend = await tasksIn(tb, spendChannel(run));
  const gates = await tasksIn(tb, gatesChannel(run));
  const all = [...work, ...spend, ...gates];
  const find = (stage: string, rev = 1) => all.find((t) => t.labels?.stage === stage && t.labels?.rev === String(rev));
  const annotate = (rev = 1) =>
    work
      .filter((t) => t.labels?.stage === "annotate" && t.labels?.rev === String(rev))
      .sort((a, b) => a.labels!.shot!.localeCompare(b.labels!.shot!));
  return { work, spend, gates, all, find, annotate };
}

function gateBlocked(run: string, rev = 1) {
  return waitFor(
    `gate r${rev} blocked`,
    async () => {
      const gate = (await tasksOf(run)).find(GATE, rev);
      return gate?.task?.state === "blocked" && gate.task.block_kind === "approval" ? gate : null;
    },
    40_000,
  );
}

async function conductorReplies(gateId: string): Promise<Message[]> {
  const thread = await tb.as("observer").thread(gateId);
  return thread.replies.filter((r) => r.by.handle === "local/conductor");
}

const dirOf = (run: string) => runDir(testConfig(tb), run);

test(
  "analysis end to end: transcribe in spend, one annotate task per shot, blueprint after all of them, a per-shot gate packet",
  async () => {
    const run = "an-happy";
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = false;
    // shot_02 is held, to show the blueprint waits for every shot.
    const hold: Behavior = async (_claim, brief) => {
      if (brief.shot === "shot_02") {
        holding = true;
        await held;
      }
    };
    const workers = startAnalysisWorkers(tb, run, 3, { annotator: hold });
    // A second annotator works the other shots while one holds shot_02.
    const second = startAnalysisWorker(tb, workChannel(run), "annotator", 3, hold);
    const conductor = start(run, { pipeline: "analysis", params: { source: "source/ref.mov" } });

    await waitFor("shot_02 held", async () => holding);
    let tasks = await tasksOf(run);
    const transcribe = tasks.find("transcribe")!;
    expect(transcribe.channel).toBe(spendChannel(run));
    expect(transcribe.task?.assignee).toContain("gateway");
    expect(parseBrief(transcribe.text)).toMatchObject({ role: "gateway", params: { op: "transcribe" }, inputs: ["analysis/probe.json"] });
    expect(tasks.work.some((t) => t.labels?.stage === "transcribe")).toBe(false);
    expect(parseBrief(tasks.find("probe")!.text).params).toEqual({ source: "source/ref.mov" });
    expect(parseBrief(tasks.find("shots")!.text).params).toEqual({ source: "source/ref.mov" });

    const annotate = tasks.annotate();
    expect(annotate.map((t) => t.labels?.shot)).toEqual(["shot_01", "shot_02", "shot_03"]);
    for (const [i, t] of annotate.entries()) {
      const id = shotId(i + 1);
      expect(t.labels).toMatchObject({ run, stage: "annotate", rev: "1", shot: id, kind: "stage" });
      expect(t.task?.assignee).toContain("annotator");
      expect(parseBrief(t.text)).toMatchObject({
        stage: "annotate",
        role: "annotator",
        shot: id,
        inputs: [
          `analysis/storyboard/${id}/start.jpg`,
          `analysis/storyboard/${id}/end.jpg`,
          "analysis/shots.json",
          "analysis/transcript.json",
        ],
        output: `analysis/annotations/${id}.json`,
        schema: "ShotAnnotation@1",
      });
      expect([...t.task!.needs].sort()).toEqual([tasks.find("shots")!.id, transcribe.id].sort());
    }
    // The blueprint waits while shot_02 is unfinished.
    await waitFor("shots 1 and 3 annotated", async () => {
      const list = (await tasksOf(run)).annotate();
      return list.filter((t) => t.task?.state === "completed").length === 2;
    });
    await sleep(500);
    tasks = await tasksOf(run);
    const blueprint = tasks.find("blueprint")!;
    expect(blueprint.task?.state).toBe("waiting");
    expect([...blueprint.task!.needs].sort()).toEqual(tasks.annotate().map((t) => t.id).sort());
    expect(tasks.find(GATE)!.task?.state).toBe("waiting");
    release();

    const gate = await gateBlocked(run);
    const [packet, ...others] = await conductorReplies(gate.id);
    expect(others).toHaveLength(0);
    expect(packet!.text).toContain("1. **Source analysis** (`analysis/source_analysis.md`)");
    expect(packet!.text).toContain("2. **shot_01** (`analysis/storyboard/shot_01/start.jpg`): 0.0s–1.0s · purpose of shot_01");
    expect(packet!.text).toContain("Dialogue: hello");
    expect(packet!.text).toContain("4. **shot_03**");
    const page = await readFile(path.join(dirOf(run), "review", `${GATE}-1.html`), "utf8");
    expect(page).toContain('src="../analysis/storyboard/shot_02/start.jpg"');
    expect(page).toContain("3 shots.");

    await tb.as(null).reply(gate.id, "approve");
    expect(await conductor.done).toBe("completed");
    tasks = await tasksOf(run);
    expect(tasks.find(GATE)!.task?.state).toBe("completed");
    expect(tasks.work).toHaveLength(6); // probe, shots, 3 annotate, blueprint
    expect(tasks.spend).toHaveLength(1);
    const status = (await threadsIn(tb, statusChannel(run))).map((m) => m.text).join("\n");
    expect(status).toContain("pipeline analysis");
    expect(status).toContain("completed");
    const recorded = JSON.parse(await readFile(path.join(dirOf(run), "run.json"), "utf8"));
    expect(recorded).toMatchObject({ pipeline: "analysis", params: { source: "source/ref.mov" } });
    await Promise.all([workers.stop(), second.stop()]);
  },
  T,
);

test(
  "40 shots: annotate tasks are created in chunks of 15, and the blueprint waits within the board's limit on needs",
  async () => {
    const run = "an-many";
    const workers = startAnalysisWorkers(tb, run, 40);
    const conductor = start(run);
    const gate = await gateBlocked(run);
    const tasks = await tasksOf(run);
    const annotate = tasks.annotate();
    expect(annotate).toHaveLength(40);
    expect(new Set(annotate.map((t) => t.labels?.shot)).size).toBe(40);
    expect(annotate.every((t) => t.task?.state === "completed")).toBe(true);
    const blueprint = tasks.find("blueprint")!;
    expect(blueprint.task!.needs.length).toBeLessThanOrEqual(32);
    expect(tasks.work.filter((t) => t.labels?.stage === "blueprint")).toHaveLength(1);
    // The fake blueprint reads every annotation, so its completing proves it ran after all 40.
    expect(blueprint.task?.state).toBe("completed");
    const [packet] = await conductorReplies(gate.id);
    expect(packet!.text.length).toBeLessThan(10_000);
    expect(packet!.text).toContain("41. **shot_40**");
    await tb.as(null).reply(gate.id, "approve");
    expect(await conductor.done).toBe("completed");
    await workers.stop();
  },
  T,
);

test(
  "revise at the gate redoes every shot at revision 2 with the notes, then the blueprint and a new gate",
  async () => {
    const run = "an-revise";
    const workers = startAnalysisWorkers(tb, run, 3);
    const conductor = start(run);
    const gate1 = await gateBlocked(run, 1);
    await tb.as(null).reply(gate1.id, "revise: name the product in every shot");
    const gate2 = await gateBlocked(run, 2);

    const tasks = await tasksOf(run);
    const r2 = tasks.annotate(2);
    expect(r2.map((t) => t.labels?.shot)).toEqual(["shot_01", "shot_02", "shot_03"]);
    for (const t of r2) expect(parseBrief(t.text).notes).toBe("name the product in every shot");
    expect(tasks.annotate(1).every((t) => t.task?.state === "completed")).toBe(true);
    const blueprint2 = tasks.find("blueprint", 2)!;
    expect(parseBrief(blueprint2.text).notes).toBe("name the product in every shot");
    expect(new Set(blueprint2.task!.needs).size).toBeLessThanOrEqual(3);
    expect(blueprint2.task!.needs.every((id) => r2.some((t) => t.id === id))).toBe(true);
    expect(gate2.task?.needs).toEqual([blueprint2.id]);
    // probe, shots and transcribe are not redone.
    expect(tasks.all.filter((t) => ["probe", "shots", "transcribe"].includes(t.labels!.stage!))).toHaveLength(3);
    const [packet] = await conductorReplies(gate2.id);
    expect(packet!.text).toContain("purpose of shot_01 (name the product in every shot)");
    const annotation = JSON.parse(await readFile(path.join(dirOf(run), "analysis/annotations/shot_02.json"), "utf8"));
    expect(annotation.notes).toBe("name the product in every shot");

    await tb.as(null).reply(gate2.id, "approve");
    expect(await conductor.done).toBe("completed");
    await workers.stop();
  },
  T,
);

test(
  "a conductor that dies at any write, and at each chunk of the fan-out, duplicates nothing",
  async () => {
    const run = "an-crashy";
    const shots = 20; // two chunks: 15 and 5
    let release!: () => void;
    const transcribing = new Promise<void>((resolve) => (release = resolve));
    // The transcript is held, so the fan-out waits until the targeted lives below.
    const workers = startAnalysisWorkers(tb, run, shots, { gateway: () => transcribing });
    const config = testConfig(tb);
    let decided = false;

    type Death = { at: "write" | "batch"; n: number; lostAnswer: boolean };
    /** One life of the conductor, which dies at its nth write (or nth batch write): before sending it, or after the board answered. */
    async function life(death: Death, ms: number): Promise<string | null> {
      let writes = 0;
      let batches = 0;
      const handle = board({
        url: tb.url,
        name: tb.name,
        profile: "conductor",
        fetch: async (url, init) => {
          if (init.method === "GET") return fetch(url, init);
          writes += 1;
          if (String(url).includes("/tasks/batch")) batches += 1;
          const count = death.at === "write" ? writes : String(url).includes("/tasks/batch") ? batches : 0;
          if (count !== death.n) return fetch(url, init);
          if (death.lostAnswer) await fetch(url, init);
          throw new Error(`crash at write ${writes}`);
        },
      });
      const driver = new RunDriver(config, run, analysisPipeline(), handle, { log: () => {} });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      let outcome: string | null = null;
      try {
        const result = await driver.drive(controller.signal);
        if (result !== "aborted") outcome = result;
      } catch (error) {
        expect(String(error)).toContain("crash at write");
      } finally {
        clearTimeout(timer);
      }
      const gate = (await tasksOf(run)).find(GATE);
      if (!decided && gate?.task?.state === "blocked") {
        await tb.as(null).reply(gate.id, "approve");
        decided = true;
      }
      return outcome;
    }
    // Each life dies at one of its first six writes, in turn, before sending it
    // or after the answer was lost, so every phase dies at each early write.
    const cycle = (i: number): Death => ({ at: "write", n: (Math.floor(i / 2) % 6) + 1, lostAnswer: i % 2 === 1 });

    // Up to the fan-out: probe and shots done, the transcript held.
    for (let i = 0; ; i++) {
      expect(i).toBeLessThan(200);
      await life(cycle(i), 300);
      const tasks = await tasksOf(run);
      if (tasks.find("shots")?.task?.state === "completed" && tasks.find("transcribe")?.task?.state === "claimed") break;
    }
    expect((await tasksOf(run)).annotate()).toHaveLength(0);
    release();
    await waitFor("the transcript", async () => (await tasksOf(run)).find("transcribe")?.task?.state === "completed");

    // The fan-out, killed at each chunk: before the first is sent, after it was
    // taken but the answer lost, before the second, and after the second was taken.
    const counts: number[] = [];
    for (const lostAnswer of [false, true, false, true]) {
      await life({ at: "batch", n: 1, lostAnswer }, 3000);
      counts.push((await tasksOf(run)).annotate().length);
    }
    expect(counts).toEqual([0, 15, 15, 20]);

    // And on to the end.
    let outcome: string | null = null;
    for (let i = 0; !outcome; i++) {
      expect(i).toBeLessThan(400);
      outcome = await life(cycle(i), 500);
    }
    expect(outcome).toBe("completed");
    const tasks = await tasksOf(run);
    const annotate = tasks.annotate();
    expect(annotate).toHaveLength(shots);
    expect(new Set(annotate.map((t) => t.labels?.shot)).size).toBe(shots);
    expect(tasks.work).toHaveLength(shots + 3);
    expect(tasks.spend).toHaveLength(1);
    expect(tasks.gates).toHaveLength(1);
    expect(await conductorReplies(tasks.find(GATE)!.id)).toHaveLength(2);
    expect(await threadsIn(tb, statusChannel(run))).toHaveLength(4);
    await workers.stop();
  },
  240_000,
);

test(
  "a restart reads the pipeline and source from run.json, and refuses a different source",
  async () => {
    const run = "an-restart";
    // The default source comes from the project's socialv.json.
    await writeFile(path.join(tb.projectDir, "socialv.json"), JSON.stringify({ source: "source/from-project.mp4" }));
    const first = start(run);
    await waitFor("probe", async () => (await tasksOf(run)).find("probe"));
    expect(await first.stop()).toBe("aborted");
    const recorded = JSON.parse(await readFile(path.join(dirOf(run), "run.json"), "utf8"));
    expect(recorded).toMatchObject({ pipeline: "analysis", params: { source: "source/from-project.mp4" } });

    await expect(start(run, { params: { source: "source/other.mov" } }).done).rejects.toThrow(/started with source=/);

    // No flags: it carries on with what run.json says.
    await writeFile(path.join(tb.projectDir, "socialv.json"), JSON.stringify({ source: "source/changed.mp4" }));
    const second = start(run, {});
    await sleep(800);
    expect(await second.stop()).toBe("aborted");
    const tasks = await tasksOf(run);
    expect(tasks.work.filter((t) => t.labels?.stage === "probe")).toHaveLength(1);
    expect(parseBrief(tasks.find("probe")!.text).params).toEqual({ source: "source/from-project.mp4" });
    // Still the analysis pipeline: nothing from the demo was created.
    expect(tasks.work.map((t) => t.labels!.stage!).sort()).toEqual(["probe", "shots"]);

    await expect(start("an-unknown", { pipeline: "nope" }).done).rejects.toThrow(/no pipeline named nope/);
    await expect(start("an-bad-param", { pipeline: "demo", params: { source: "x" } }).done).rejects.toThrow(/takes no parameter source/);
  },
  T,
);

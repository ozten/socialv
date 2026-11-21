import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runDir } from "../../src/config.ts";
import { ShotAnnotation } from "../../src/schemas/analysis.ts";
import { runMentions } from "../../src/step/index.ts";
import { readFakeLog } from "../../src/step/fake.ts";
import { getSchema } from "../../src/step/schemas.ts";
import { REFERRED, rulingFrom } from "../../src/workers/agents/creative-director/fake.ts";
import { getRole } from "../../src/workers/registry.ts";
import { startBoard, type TestBoard } from "../helpers/board.ts";
import { claimAndStep, configOf, createTask, taskOf, until, writeRunFile } from "../step/kit.ts";

let tb: TestBoard;
beforeAll(async () => {
  tb = await startBoard("agents-test");
});
afterAll(() => tb.stop());

const dirOf = (run: string) => runDir(configOf(tb), run);

async function seedAnalysis(run: string) {
  await writeRunFile(tb, run, "analysis/shots.json", {
    shots: [1, 2, 3].map((n) => ({
      shot_id: `shot_0${n}`,
      start_sec: n - 1,
      end_sec: n,
      keyframes: [
        { path: `analysis/storyboard/shot_0${n}/a.jpg`, time_sec: n - 0.9, reason: "start" },
        { path: `analysis/storyboard/shot_0${n}/b.jpg`, time_sec: n - 0.5, reason: "middle" },
      ],
    })),
    detector: { method: "scene", threshold: 0.3 },
  });
  await writeRunFile(tb, run, "analysis/transcript.json", {
    language: "en",
    text: "try it now today",
    words: [
      { text: "try", start_sec: 0.2, end_sec: 0.4, speaker: null },
      { text: "it", start_sec: 1.1, end_sec: 1.2, speaker: null },
      { text: "now", start_sec: 1.3, end_sec: 1.6, speaker: null },
      { text: "today", start_sec: 2.2, end_sec: 2.6, speaker: null },
    ],
    events: [{ label: "music", start_sec: 0, end_sec: 3 }],
    provider: "fake",
    model: "fake",
  });
}

function annotateTask(run: string, shot = "shot_02", notes?: string) {
  return createTask(
    tb,
    {
      run,
      stage: "annotate",
      role: "annotator",
      shot,
      inputs: [`analysis/storyboard/${shot}/a.jpg`, `analysis/storyboard/${shot}/b.jpg`, "analysis/shots.json", "analysis/transcript.json"],
      output: `analysis/annotations/${shot}.json`,
      schema: "ShotAnnotation@1",
      ...(notes ? { notes } : {}),
    },
    `Describe ${shot}.`,
  );
}

test("the fake annotator, through the real step, writes a valid annotation from the shot's data", async () => {
  const run = "a1";
  await seedAnalysis(run);
  const task = await annotateTask(run);
  expect((await claimAndStep(tb, "annotator", task.id)).code).toBe(0);

  const after = await taskOf(tb, task.id);
  expect(after.task?.state).toBe("completed");
  expect(after.task?.result).toMatch(/^Described shot_02 \(beat 2 of 3\)\.\noutput: analysis\/annotations\/shot_02\.json sha256:[0-9a-f]{64}$/);
  const annotation = ShotAnnotation.parse(JSON.parse(await readFile(path.join(dirOf(run), "analysis/annotations/shot_02.json"), "utf8")));
  expect(annotation.shot_id).toBe("shot_02");
  expect(annotation.action_beats).toEqual(["frame at 1.10s (start)", "frame at 1.50s (middle)", 'someone says "it now"']);
});

test("the annotator's prompt has the literal task ID, the keyframe paths, the shot's words and the schema hint", async () => {
  const run = "a2";
  await seedAnalysis(run);
  const task = await annotateTask(run, "shot_01", "say what the hand holds");
  expect((await claimAndStep(tb, "annotator", task.id)).code).toBe(0);
  const [session] = await readFakeLog(dirOf(run));
  const prompt = session!.prompt;
  expect(prompt).toContain(`Task ${task.id} `);
  expect(prompt).toContain(`openboard reply ${task.id} "@local/creative-director`);
  expect(prompt).toContain(path.join(dirOf(run), "analysis/storyboard/shot_01/a.jpg"));
  expect(prompt).toContain(path.join(dirOf(run), "analysis/storyboard/shot_01/b.jpg"));
  expect(prompt).toContain(getSchema("ShotAnnotation@1")!.hint);
  expect(prompt).toContain('"try"');
  expect(prompt).not.toContain("today");
  expect(prompt).toContain("music (0.00s–3.00s)");
  expect(prompt).toContain("say what the hand holds");
  expect(prompt).toContain(`${path.join(dirOf(run), "analysis/annotations/shot_01.json")}.draft`);

  const role = getRole("annotator");
  expect(role?.kind).toBe("agent");
  const system = role!.kind === "agent" ? role!.systemPrompt(configOf(tb)) : "";
  for (const rule of ["only what is visible", "exactly as", "Never identify a real person by name", "Claims are not facts", "At most one question"]) {
    expect(system).toContain(rule);
  }
});

/** Runs the creative director's mention loop for the duration of `fn`. */
async function withDirector<T>(fn: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => (ready = resolve));
  const loop = runMentions(configOf(tb), "creative-director", { signal: controller.signal, onReady: ready });
  await listening;
  try {
    return await fn();
  } finally {
    controller.abort();
    await loop;
  }
}

test("the fake creative director answers a mention from the brief, and logs the ruling", async () => {
  const run = "a3";
  const brief = "# Fresh, playful, and honest: no health claims\n\nA 20-second ad for sparkling water.\n";
  await writeFile(path.join(tb.projectDir, "brief.md"), brief);
  try {
    await seedAnalysis(run);
    const task = await annotateTask(run);
    await withDirector(async () => {
      await tb.as("annotator").reply(task.id, "@local/creative-director Which bottle is the hero, the green or the clear one?");
      await until("the ruling", async () => (await tb.as("conductor").thread(task.id)).replies.length === 2);
    });
    const { replies } = await tb.as("conductor").thread(task.id);
    const answer = replies[1]!;
    expect(answer.by.handle).toBe("local/creative-director");
    expect(answer.mentions?.map((m) => `${m.handle}/${m.profile}`)).toEqual(["local/annotator"]);
    expect(answer.text).toContain(rulingFrom(brief));
    const decisions = await readFile(path.join(dirOf(run), "creative/decisions.md"), "utf8");
    expect(decisions).toBe(
      `- ${task.id}: Which bottle is the hero, the green or the clear one? -> ${rulingFrom(brief)} (asked by local/annotator)\n`,
    );
    expect(rulingFrom(brief)).toBe("keep to the brief: Fresh, playful, and honest: no health claims");
  } finally {
    await rm(path.join(tb.projectDir, "brief.md"), { force: true });
  }
});

test("with no brief to rule from, the fake creative director refers the question to the owner", async () => {
  const run = "a4";
  await seedAnalysis(run);
  const task = await annotateTask(run);
  await withDirector(async () => {
    await tb.as("annotator").reply(task.id, "@local/creative-director Is the logo on screen ours?");
    await until("the referral", async () => (await tb.as("conductor").thread(task.id)).replies.length === 2);
  });
  const answer = (await tb.as("conductor").thread(task.id)).replies[1]!;
  expect(answer.mentions?.map((m) => [m.handle, m.profile])).toEqual([["local", undefined]]);
  const decisions = await readFile(path.join(dirOf(run), "creative/decisions.md"), "utf8");
  expect(decisions).toContain(`-> ${REFERRED} (asked by local/annotator)`);
});

test("rework notes that name shots: an unnamed shot keeps its output without a session; a named shot sees only its own note", async () => {
  const run = "a-pershot";
  await seedAnalysis(run);
  const first = await annotateTask(run, "shot_01");
  expect((await claimAndStep(tb, "annotator", first.id)).code).toBe(0);
  const file = path.join(dirOf(run), "analysis/annotations/shot_01.json");
  const before = await readFile(file, "utf8");
  const sessions = (await readFakeLog(dirOf(run))).length;

  const notes = "shot_02: the bottle is green, not amber\nshot_03: she is standing";
  const kept = await annotateTask(run, "shot_01", notes);
  expect((await claimAndStep(tb, "annotator", kept.id)).code).toBe(0);
  const after = await taskOf(tb, kept.id);
  expect(after.task?.state).toBe("completed");
  expect(after.task?.result).toMatch(/^kept: not named in the rework notes\noutput: analysis\/annotations\/shot_01\.json sha256:/);
  expect(await readFile(file, "utf8")).toBe(before);
  expect((await readFakeLog(dirOf(run))).length).toBe(sessions);

  const redone = await annotateTask(run, "shot_02", notes);
  expect((await claimAndStep(tb, "annotator", redone.id)).code).toBe(0);
  const log = await readFakeLog(dirOf(run));
  expect(log.length).toBe(sessions + 1);
  const prompt = log.at(-1)!.prompt;
  expect(prompt).toContain("the bottle is green, not amber");
  expect(prompt).not.toContain("she is standing");
});

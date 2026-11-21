// The project view and the decision endpoint, against a real local board.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGateReply, reviseShots, shotNotes, formatGateDecision } from "../../src/board/gate.ts";
import { gatesChannel } from "../../src/channels.ts";
import { runDir } from "../../src/config.ts";
import { gateState, runReview } from "../../src/review/index.ts";
import { startBoard, type TestBoard } from "../helpers/board.ts";
import { configOf, writeRunFile } from "../step/kit.ts";

const HOSTILE = `<script>alert("x")</script>`;
let tb: TestBoard;
let server: { url: string; close(): Promise<void> };
const run = "p1";

async function openGate(rev: number) {
  const conductor = tb.as("conductor");
  const { task } = await conductor.tasks.create(gatesChannel(run), {
    text: `Gate r${rev}`,
    labels: { run, stage: "blueprint-review", rev: String(rev), kind: "gate" },
    for: "conductor",
  });
  const claim = await conductor.tasks.claim({ channel: gatesChannel(run) });
  expect(claim?.task.id).toBe(task.id);
  await claim!.block("Waiting for the owner.", { kind: "approval" });
  return task.id;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.url}/api/runs/${run}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: server.url, ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  tb = await startBoard("app-test");
  const config = configOf(tb);
  const annotation = (shot_id: string) => ({
    shot_id, purpose: `hook ${HOSTILE}`, framing: "close-up", camera_motion: "static", subjects: ["a bottle"],
    action_beats: ["lifts the bottle"], product_interaction: null, environment: "a kitchen", on_screen_text: [], notes: null,
  });
  await writeRunFile(tb, run, "run.json", { pipeline: "analysis", params: { source: "source/ref.mov" }, started_at: "x" });
  await writeRunFile(tb, run, "analysis/blueprint.json", {
    source: { duration_sec: 2, width: 720, height: 1280, fps: 30 },
    transcript_path: null,
    shots: ["shot_01", "shot_02"].map((id, i) => ({
      shot_id: id, start_sec: i, end_sec: i + 1, dialogue: "hello", keyframes: [`analysis/storyboard/${id}/1_start.jpg`], annotation: annotation(id),
    })),
  });
  await mkdir(path.join(config.projectDir, "source"), { recursive: true });
  await writeFile(path.join(config.projectDir, "source", "ref.mov"), "MOVIE");
  await writeFile(path.join(config.projectDir, "secrets.env"), "FAL_KEY=secret");
  await mkdir(runDir(config, run), { recursive: true });
  server = await runReview(config, { port: 0 });
});
afterAll(async () => {
  await server?.close();
  await tb.stop();
});

describe("notes per shot", () => {
  it("round-trips through a revise decision", () => {
    const text = formatGateDecision(reviseShots({ shot_03: "she is\nstanding", shot_01: "green bottle" }));
    expect(text).toBe("revise: shot_01: green bottle\nshot_03: she is standing");
    const decision = parseGateReply(text);
    expect(decision?.kind).toBe("revise");
    expect([...shotNotes(decision?.kind === "revise" ? decision.notes : null)!]).toEqual([
      ["shot_01", "green bottle"],
      ["shot_03", "she is standing"],
    ]);
  });
  it("is null for notes that are not all per shot, so they apply to every shot", () => {
    expect(shotNotes("make it shorter")).toBeNull();
    expect(shotNotes("shot_01: fix\nand everything else too")).toBeNull();
    expect(shotNotes(null)).toBeNull();
  });
});

describe("the project view", () => {
  it("shows each scene with its clip and description, escaped, and loads only our own script", async () => {
    const res = await fetch(`${server.url}/runs/${run}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).toContain('data-shot="shot_02"');
    expect(html).toContain('src="/project/source/ref.mov#t=1,2"');
    expect(html).toContain("&lt;script&gt;alert");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script src="/app/project.js"></script>');
    expect((await fetch(`${server.url}/app/project.js`)).headers.get("content-type")).toContain("javascript");
  });
  it("keeps the file listing at ?files, serves the reference video, and nothing else from the project folder", async () => {
    expect(await (await fetch(`${server.url}/runs/${run}/?files`)).text()).toContain("All files in the run folder");
    expect(await (await fetch(`${server.url}/project/source/ref.mov`)).text()).toBe("MOVIE");
    expect((await fetch(`${server.url}/project/secrets.env`)).status).toBe(404);
    expect((await fetch(`${server.url}/project/source/..%2Fsecrets.env`)).status).toBe(404);
  });
});

describe("decisions", () => {
  it("says the run is still running before any approval exists", async () => {
    expect((await gateState(configOf(tb), run)).state).toBe("running");
  });

  it("records a decision on the board as studio, and refuses anything not from its own page", async () => {
    const gate = await openGate(1);
    const state = await (await fetch(`${server.url}/api/runs/${run}`)).json();
    expect(state).toMatchObject({ state: "waiting", gate: { id: gate, rev: 1 } });

    expect((await post({ gate, kind: "approve" }, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await post({ gate, kind: "approve" }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post({ gate: "msg_other", kind: "approve" })).status).toBe(409);
    expect((await post({ gate, kind: "revise", shots: {} })).status).toBe(400);
    expect((await post({ gate, kind: "revise", shots: { "../x": "note" } })).status).toBe(400);
    expect((await post({ gate, kind: "reject", reason: " " })).status).toBe(400);
    expect((await tb.as(null).thread(gate)).replies).toHaveLength(0);

    const res = await post({ gate, kind: "revise", shots: { shot_02: "the bottle is green" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, summary: "1 scene sent back for a fix." });
    // The same click sent twice is one reply.
    expect((await post({ gate, kind: "revise", shots: { shot_02: "the bottle is green" } })).status).toBe(200);
    const replies = (await tb.as(null).thread(gate)).replies;
    expect(replies).toHaveLength(1);
    expect(replies[0]!.by.handle).toBe("local/studio");
    expect(parseGateReply(replies[0]!.text)).toEqual({ kind: "revise", notes: "shot_02: the bottle is green" });
  });
});

// A render job end to end on a real local board, with the fake renderer: the
// plan becomes priced envelopes, the spend gate lists them with their
// digests, and the gateway sends only what the owner approved, once.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "openboardlol";
import { afterAll, beforeAll, expect, test } from "vitest";
import { gatesChannel, spendChannel, workChannel } from "../../src/channels.ts";
import { runDir } from "../../src/config.ts";
import { runConductor } from "../../src/conductor/index.ts";
import { bindingLine, packetActions } from "../../src/gateway/approval.ts";
import { fakeRenderer, useRenderer } from "../../src/gateway/renderers.ts";
import { Envelopes, Take } from "../../src/schemas/render.ts";
import { formatBrief } from "../../src/schemas/brief.ts";
import { tasksIn, testConfig, waitFor } from "../conductor/helpers.ts";
import { startBoard, type TestBoard } from "../helpers/board.ts";
import { claimAndStep, taskOf } from "../step/kit.ts";
import { ledgerRow } from "./kit.ts";

let tb: TestBoard;
beforeAll(async () => {
  tb = await startBoard("render-test");
  await tb.as("observer").post("setup", "test board up");
});
afterAll(async () => {
  useRenderer(null);
  await tb.stop();
});

const RUN = "r1";
const ENDPOINT = "bytedance/seedance-2.5/reference-to-video";

function plan() {
  const take = (id: string, label: string) => ({
    id,
    shot: "shot_06",
    label,
    endpoint: ENDPOINT,
    input: { prompt: `@Image1 holds the bottle (${id})`, duration: 4, aspect_ratio: "9:16", generate_audio: true },
    files: [
      { field: "image_urls", path: "assets/presenter.png" },
      { field: "audio_urls", path: "assets/line.mp3" },
    ],
  });
  return { v: 1, name: "t1", takes: [take("a", "references only"), take("b", "with a first frame")] };
}

async function find(stage: string): Promise<Message | undefined> {
  const all = [
    ...(await tasksIn(tb, workChannel(RUN))),
    ...(await tasksIn(tb, spendChannel(RUN))),
    ...(await tasksIn(tb, gatesChannel(RUN))),
  ];
  return all.find((t) => t.labels?.stage === stage);
}

/** A render task made by hand, as the conductor would make it. */
async function renderTask(take: string): Promise<Message> {
  const { task } = await tb.as("conductor").tasks.create(spendChannel(RUN), {
    text: formatBrief(`Render take ${take} (by hand)`, {
      v: 1,
      run: RUN,
      stage: `manual-${take}`,
      role: "gateway",
      inputs: ["renders/t1/envelopes.json"],
      output: `renders/manual/${take}-${Date.now()}.json`,
      schema: "Take@1",
      params: { op: "render", take, gate: "t1-spend" },
    }),
    for: "gateway",
  });
  return task;
}

test("the packet's numbered actions are read back by action and digest", () => {
  const digest = "a".repeat(64);
  const text = [`@local **Spend**`, "", `1. **Scene 06, take a** (\`x.json\`): ${bindingLine("t1-a-0123456789", digest)}`, "Cost: about $1.89", `2. **other**: no binding here`].join("\n");
  expect(packetActions(text)).toEqual([{ n: 1, action_id: "t1-a-0123456789", digest }]);
});

test(
  "a render job: priced envelopes, a spend gate, and only the approved take is sent, once",
  async () => {
    const config = testConfig(tb);
    const dir = runDir(config, RUN);
    await mkdir(path.join(tb.projectDir, "assets"), { recursive: true });
    await writeFile(path.join(tb.projectDir, "assets", "presenter.png"), "presenter image");
    await writeFile(path.join(tb.projectDir, "assets", "line.mp3"), "the line, spoken");
    await mkdir(path.join(dir, "renders", "t1"), { recursive: true });
    await writeFile(path.join(dir, "renders", "t1", "plan.json"), JSON.stringify(plan()));

    const requests: Record<string, unknown>[] = [];
    useRenderer(() => fakeRenderer({ onSubmit: (request) => requests.push(request) }));

    const controller = new AbortController();
    const done = runConductor(config, { run: RUN, pipeline: "render", params: { plan: "t1" }, signal: controller.signal, log: () => {} });
    try {
      // The plan is priced before anyone is asked.
      const envelopesTask = await waitFor("envelopes task", () => find("t1-envelopes"));
      expect((await claimAndStep(tb, "envelopes", envelopesTask.id)).code).toBe(0);
      const list = Envelopes.parse(JSON.parse(await readFile(path.join(dir, "renders/t1/envelopes.json"), "utf8")));
      expect(list.envelopes).toHaveLength(2);
      expect(list.envelopes[0]).toMatchObject({ n: 1, take: "a", est_cost_usd: 1.892 });
      expect(list.total_est_usd).toBeCloseTo(3.784);

      const gate = await waitFor("spend gate blocked", async () => {
        const g = await find("t1-spend");
        return g?.task?.state === "blocked" ? g : null;
      });
      const packet = (await tb.as("observer").thread(gate.id)).replies[0]!;
      expect(packetActions(packet.text)).toEqual(list.envelopes.map((e) => ({ n: e.n, action_id: e.action_id, digest: e.digest })));
      expect(packet.text).toContain("Cost: about $1.89, at most $2.08");

      // Nothing is sent before the owner approves, and a stranger's approval does not count.
      const early = await renderTask("b");
      expect((await claimAndStep(tb, "gateway", early.id)).code).toBe(1);
      expect((await taskOf(tb, early.id)).task?.reason).toMatch(/not approved: the owner has not approved/);
      await tb.as("someone").reply(gate.id, "approve");
      const stranger = await renderTask("b");
      expect((await claimAndStep(tb, "gateway", stranger.id)).code).toBe(1);
      expect(requests).toHaveLength(0);

      // The owner approves item 2 only.
      await tb.as(null).reply(gate.id, "approve 2");
      const [a, b] = await waitFor("render tasks", async () => {
        const pair = [await find("t1-render-a"), await find("t1-render-b")];
        return pair[0] && pair[1] ? (pair as [Message, Message]) : null;
      });
      expect((await claimAndStep(tb, "gateway", a.id)).code).toBe(1);
      expect((await taskOf(tb, a.id)).task?.reason).toMatch(/approved items 2 .*this is item 1/);
      expect(requests).toHaveLength(0);

      expect((await claimAndStep(tb, "gateway", b.id)).code).toBe(0);
      expect(requests).toHaveLength(1);
      const sent = list.envelopes[1]!;
      expect(requests[0]).toMatchObject({ prompt: "@Image1 holds the bottle (b)", duration: "4", resolution: "720p", aspect_ratio: "9:16" });
      expect(requests[0]!.image_urls).toHaveLength(1);
      expect(requests[0]!.audio_urls).toHaveLength(1);
      const take = Take.parse(JSON.parse(await readFile(path.join(dir, "renders/takes/shot_06/t1-b.json"), "utf8")));
      expect(take).toMatchObject({ action_id: sent.action_id, video: "renders/takes/shot_06/t1-b.mp4", cost_usd: 1.892 });
      expect(await readFile(path.join(dir, take.video), "utf8")).toContain("fake video");
      expect(ledgerRow(tb, RUN, sent.action_id)).toMatchObject({ state: "succeeded", input_digest: sent.digest });

      // The same request under another task is not paid for twice.
      const again = await renderTask("b");
      expect((await claimAndStep(tb, "gateway", again.id)).code).toBe(0);
      expect(requests).toHaveLength(1);

      // A file that changed after the request was shown voids it.
      await writeFile(path.join(tb.projectDir, "assets", "presenter.png"), "a different presenter");
      const tampered = await renderTask("b");
      expect((await claimAndStep(tb, "gateway", tampered.id)).code).toBe(1);
      expect((await taskOf(tb, tampered.id)).task?.reason).toMatch(/assets\/presenter\.png changed after the request was written/);
      expect(requests).toHaveLength(1);
    } finally {
      controller.abort();
      await done;
    }
  },
  90_000,
);

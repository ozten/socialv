// A render job: price the plan's requests, have the owner approve the spend,
// render each take through the gateway, and have the owner look at the takes.
// A project can have many of these, one per plan, so node names carry the
// plan's name.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { bindingLine } from "../../gateway/approval.ts";
import type { GateItem } from "../../review/types.ts";
import { Envelope, Envelopes, Take } from "../../schemas/render.ts";
import type { Pipeline, PipelineNode, RunContext } from "../pipeline.ts";

export interface RenderTake {
  id: string;
  shot: string;
  label: string;
}

export const planPath = (name: string) => `renders/${name}/plan.json`;
export const envelopesPath = (name: string) => `renders/${name}/envelopes.json`;
export const takePath = (name: string, take: RenderTake) => `renders/takes/${take.shot}/${name}-${take.id}.json`;

export function renderPipeline(name: string, takes: RenderTake[]): Pipeline {
  const spend = `${name}-spend`;
  const renders: PipelineNode[] = takes.map((take) => ({
    kind: "stage",
    name: `${name}-render-${take.id}`,
    role: "gateway",
    channel: "spend",
    needs: [spend],
    summary: `Render ${take.shot.replace("shot_", "scene ")} take ${take.id}: ${take.label} (paid)`,
    inputs: [envelopesPath(name)],
    output: takePath(name, take),
    schema: "Take@1",
    params: { op: "render", take: take.id, gate: spend },
  }));
  return {
    name: `render ${name}`,
    job: `render-${name}`,
    nodes: [
      {
        kind: "stage",
        name: `${name}-envelopes`,
        role: "envelopes",
        needs: [],
        summary: `Render plan ${name}: write and price each request`,
        inputs: [planPath(name)],
        output: envelopesPath(name),
        schema: "Envelopes@1",
        params: {},
      },
      {
        kind: "gate",
        name: spend,
        needs: [`${name}-envelopes`],
        title: `Spend approval: ${name}`,
        summary:
          "Each item is one paid video request, exactly as it will be sent, with its cost. Approving releases the money for " +
          "the approved items only; the gateway sends nothing that is not listed here unchanged. " +
          `To change a request, edit ${planPath(name)} and reply \`revise: <what changed>\`.`,
        rework: [`${name}-envelopes`],
        items: (ctx) => spendItems(ctx, name),
      },
      ...renders,
      {
        kind: "gate",
        name: `${name}-review`,
        needs: renders.map((r) => r.name),
        title: `Take review: ${name}`,
        summary: "The rendered takes. Approve once you have looked at them; say what to change in a new plan.",
        rework: [],
        items: (ctx) => takeItems(ctx, name, takes),
      },
    ],
  };
}

/** One item per request: the binding line the gateway reads back, then what a person needs to decide. */
export async function spendItems(ctx: RunContext, name: string): Promise<GateItem[]> {
  const list = Envelopes.parse(JSON.parse(await readFile(path.join(ctx.runDir, envelopesPath(name)), "utf8")));
  const items: GateItem[] = [];
  for (const e of list.envelopes) {
    const envelope = Envelope.parse(JSON.parse(await readFile(path.join(ctx.runDir, e.path), "utf8")));
    const { prompt, ...settings } = envelope.input;
    const lines = [
      bindingLine(e.action_id, e.digest),
      `Cost: about $${e.est_cost_usd.toFixed(2)}, at most $${e.max_cost_usd.toFixed(2)}`,
      `Endpoint: ${e.endpoint}`,
      `Settings: ${Object.entries(settings).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`,
      `Files sent: ${envelope.input_files.map((f, i) => `${fileRef(envelope, i)} ${f.path}`).join("; ") || "none"}`,
      `Expires: ${envelope.expires_at}`,
      "",
      `Prompt: ${String(prompt ?? "")}`,
    ];
    items.push({
      n: e.n,
      label: `${e.shot.replace("shot_", "Scene ")}, take ${e.take}: ${e.label}`,
      text: lines.join("\n"),
      file: e.path,
      meta: { cost: `$${e.est_cost_usd.toFixed(2)} (max $${e.max_cost_usd.toFixed(2)})`, action: e.action_id },
    });
  }
  return items;
}

/** How the prompt refers to a file: @Image1, @Audio1, in order within its field. */
function fileRef(envelope: Envelope, index: number): string {
  const file = envelope.input_files[index]!;
  const nth = envelope.input_files.slice(0, index + 1).filter((f) => f.field === file.field).length;
  if (file.field === "image_urls") return `@Image${nth}`;
  if (file.field === "audio_urls") return `@Audio${nth}`;
  return file.field;
}

export async function takeItems(ctx: RunContext, name: string, takes: RenderTake[]): Promise<GateItem[]> {
  const items: GateItem[] = [];
  for (const [index, take] of takes.entries()) {
    const label = `${take.shot.replace("shot_", "Scene ")}, take ${take.id}: ${take.label}`;
    try {
      const done = Take.parse(JSON.parse(await readFile(path.join(ctx.runDir, takePath(name, take)), "utf8")));
      items.push({ n: index + 1, label, file: done.video, meta: { cost: `$${done.cost_usd.toFixed(2)}`, seed: String(done.seed ?? "none") } });
    } catch (error) {
      items.push({ n: index + 1, label, text: `(no take: ${(error as Error).message})` });
    }
  }
  return items;
}

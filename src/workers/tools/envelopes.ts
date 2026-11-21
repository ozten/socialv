// Turns a render plan into envelopes: one file per paid request, with its
// input files hashed and its cost priced, before anyone is asked to approve
// (design 6.4). Sends nothing and holds no key.

import { readFile, stat } from "node:fs/promises";
import { inputDigest } from "../../gateway/action.ts";
import { estimate } from "../../gateway/prices.ts";
import { basisOf } from "../../gateway/render.ts";
import { FILE_FIELDS, RenderPlan, type Envelope, type Envelopes } from "../../schemas/render.ts";
import { inside, sha256, writeAtomic } from "../../step/files.ts";
import type { ToolRole } from "../types.ts";

/** How long an approval stays usable. */
const VALID_HOURS = 24;

export function envelopePath(actionId: string): string {
  return `manifests/envelopes/${actionId}.json`;
}

export const envelopes: ToolRole = {
  name: "envelopes",
  kind: "tool",
  async run({ config, brief, runDir, readInput }) {
    const plan = RenderPlan.parse(await readInput(0));
    const expires = new Date(Date.now() + VALID_HOURS * 3600_000).toISOString();
    const out: Envelopes = { plan: plan.name, total_est_usd: 0, total_max_usd: 0, envelopes: [] };

    for (const [index, take] of plan.takes.entries()) {
      const where = `take ${take.id}`;
      for (const field of FILE_FIELDS) {
        if (field in take.input) throw new Error(`${where}: ${field} belongs in "files", as a path, not in "input"`);
      }
      if ("video_urls" in take.input) throw new Error(`${where}: video inputs are not priced yet`);
      // All video is generated at 720p, and a request must say how long it is to be priced.
      const input: Record<string, unknown> = { ...take.input, resolution: take.input.resolution ?? "720p" };
      if (input.resolution !== "720p") throw new Error(`${where}: resolution must be 720p`);
      if (!/^\d+$/.test(String(input.duration ?? ""))) throw new Error(`${where}: duration must be a whole number of seconds`);
      input.duration = String(input.duration);
      const price = estimate(take.endpoint, basisOf(input));

      const input_files: Envelope["input_files"] = [];
      for (const file of take.files) {
        const full = inside(config.projectDir, file.path);
        const bytes = await readFile(full).catch(() => {
          throw new Error(`${where}: cannot read ${file.path} in the project folder`);
        });
        input_files.push({ field: file.field, path: file.path, sha256: sha256(bytes), bytes: (await stat(full)).size });
      }

      const body = {
        v: 1 as const,
        run: brief.run,
        plan: plan.name,
        take: take.id,
        shot: take.shot,
        label: take.label,
        endpoint: take.endpoint,
        input,
        input_files,
        est_cost_usd: price.estimated_usd,
        max_cost_usd: price.max_cost_usd,
      };
      // The ID names the content: a changed request is a different action, and the same one is never paid for twice.
      const action_id = `${plan.name}-${take.id}-${inputDigest(body).slice(0, 10)}`;
      const envelope: Envelope = { ...body, action_id, expires_at: expires };
      const path = envelopePath(action_id);
      await writeAtomic(inside(runDir, path), `${JSON.stringify(envelope, null, 2)}\n`);
      out.envelopes.push({
        n: index + 1,
        action_id,
        digest: inputDigest(envelope),
        path,
        take: take.id,
        shot: take.shot,
        label: take.label,
        endpoint: take.endpoint,
        est_cost_usd: price.estimated_usd,
        max_cost_usd: price.max_cost_usd,
      });
      out.total_est_usd += price.estimated_usd;
      out.total_max_usd += price.max_cost_usd;
    }
    out.total_est_usd = Math.round(out.total_est_usd * 1e6) / 1e6;
    out.total_max_usd = Math.round(out.total_max_usd * 1e6) / 1e6;
    return {
      value: out,
      summary: `${out.envelopes.length} request(s) written: estimated $${out.total_est_usd.toFixed(2)}, at most $${out.total_max_usd.toFixed(2)}`,
    };
  },
};

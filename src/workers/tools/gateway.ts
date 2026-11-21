// The spend gateway: the only role that holds provider keys and spends money
// (design 7). It claims tasks in `spend/<run>`, kept for `gateway`, and
// dispatches on `params.op`. Every operation spends through `runPaidAction`.

import { z } from "zod";
import { connect } from "../../board/connect.ts";
import { GATEWAY } from "../../channels.ts";
import type { CrashHooks } from "../../gateway/action.ts";
import { boardNotifier } from "../../gateway/notify.ts";
import { render, RenderParams } from "../../gateway/render.ts";
import { transcribe } from "../../gateway/transcribe.ts";
import type { ToolRole } from "../types.ts";

/** Test-only knobs: crash points and a shorter provider wait. */
export const gatewayTestOptions: { hooks?: CrashHooks; waitTimeoutMs?: number } = {};

const TranscribeParams = z.object({ op: z.literal("transcribe"), endpoint: z.string().optional() });

export const gateway: ToolRole = {
  name: GATEWAY,
  kind: "tool",
  channel: "spend/",
  async run({ config, brief, taskId, runDir, readInput }) {
    const me = connect(config, GATEWAY);
    // The claim this attempt holds; it tells a crashed attempt from a concurrent one.
    const epoch = (await me.tasks.get(taskId)).task.task?.epoch ?? 0;
    const gw = {
      config,
      run: brief.run,
      runDir,
      taskId,
      epoch,
      notify: boardNotifier(me, taskId),
      waitTimeoutMs: gatewayTestOptions.waitTimeoutMs,
      hooks: gatewayTestOptions.hooks,
    };
    const op = brief.params.op;
    switch (op) {
      case "transcribe": {
        const params = TranscribeParams.parse(brief.params);
        return transcribe(gw, await readInput(0), { endpoint: params.endpoint });
      }
      case "render":
        return render(gw, me, await readInput(0), RenderParams.parse(brief.params));
      default:
        throw new Error(`gateway: unknown op ${JSON.stringify(op)} (expected "transcribe" or "render")`);
    }
  },
};

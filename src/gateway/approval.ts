// What the gateway checks before a request over the auto-approve limit
// (design 6.4 and 7, step 2): the spend gate's packet, posted by the
// conductor and never edited, lists this action with this digest, and a later
// reply from the owner approves that item. Openboard's signed approvals are
// planned; until then this is the binding.

import type { Board, Message } from "openboardlol";
import { parseGateReply } from "../board/gate.ts";
import { CONDUCTOR, gatesChannel, STUDIO } from "../channels.ts";
import { handleOf, type Config } from "../config.ts";
import type { Envelope } from "../schemas/render.ts";
import { GatewayRefusal } from "./action.ts";

/** The first line of a spend item's text in the packet. The gateway reads it back, so both sides use this. */
export function bindingLine(actionId: string, digest: string): string {
  return `action ${actionId} digest ${digest}`;
}

const ITEM = /^(\d+)\. .*?\baction ([A-Za-z0-9_-]+) digest ([0-9a-f]{64})\b/;

/** The numbered actions a packet lists. */
export function packetActions(text: string): { n: number; action_id: string; digest: string }[] {
  const out: { n: number; action_id: string; digest: string }[] = [];
  for (const line of text.split("\n")) {
    const match = ITEM.exec(line);
    if (match) out.push({ n: Number(match[1]), action_id: match[2]!, digest: match[3]! });
  }
  return out;
}

/**
 * Throws GatewayRefusal unless the owner approved this envelope at the gate
 * `gateStage` of its run. Returns a line naming the approval.
 */
export async function verifyApproval(
  me: Board,
  config: Config,
  gateStage: string,
  envelope: Envelope,
  digest: string,
  now: Date = new Date(),
): Promise<string> {
  const expires = Date.parse(envelope.expires_at);
  if (!(expires > now.getTime())) {
    throw new GatewayRefusal(`the request expired at ${envelope.expires_at}; it needs a new approval`);
  }

  const gate = await latestGate(me, envelope.run, gateStage);
  if (!gate) throw new GatewayRefusal(`there is no gate ${gateStage} for run ${envelope.run}`);
  const thread = await me.thread(gate.id);
  const replies = thread.replies.filter((r) => !r.deleted_at);
  const conductor = handleOf(config, CONDUCTOR);
  const packetAt = replies.findIndex((r) => r.by.handle === conductor);
  const packet = replies[packetAt];
  if (!packet) throw new GatewayRefusal(`gate ${gate.id} has no packet from ${conductor}`);
  if (packet.edited_at) throw new GatewayRefusal(`the packet of gate ${gate.id} was edited after it was posted`);

  const listed = packetActions(packet.text).filter((a) => a.action_id === envelope.action_id);
  const item = listed.find((a) => a.digest === digest);
  if (!item) {
    throw new GatewayRefusal(
      listed.length > 0
        ? `the packet of gate ${gate.id} lists action ${envelope.action_id} with a different digest: the request changed after it was shown`
        : `the packet of gate ${gate.id} does not list action ${envelope.action_id}`,
    );
  }

  // The first reply from the owner that is a decision is the decision, as it is for the conductor.
  const owners = new Set([config.owner, handleOf(config, STUDIO)]);
  for (const reply of replies.slice(packetAt + 1)) {
    if (!owners.has(reply.by.handle)) continue;
    const decision = parseGateReply(reply.text);
    if (!decision) continue;
    if (decision.kind !== "approve") {
      throw new GatewayRefusal(`the owner's decision at gate ${gate.id} was \`${decision.kind}\`, not approve`);
    }
    if (decision.items && !decision.items.includes(item.n)) {
      throw new GatewayRefusal(`the owner approved items ${decision.items.join(",")} at gate ${gate.id}; this is item ${item.n}`);
    }
    return `approved by ${reply.by.handle} in ${reply.id} (gate ${gate.id}, item ${item.n})`;
  }
  throw new GatewayRefusal(`the owner has not approved gate ${gate.id}`);
}

/** The highest revision of the run's gate named `stage`. */
async function latestGate(me: Board, run: string, stage: string): Promise<Message | null> {
  let best: Message | null = null;
  let bestRev = 0;
  let after: string | undefined;
  do {
    const page = await me.tasks.list({ channel: gatesChannel(run), state: "all", limit: 100, after });
    for (const { root } of page.tasks) {
      const labels = root.labels ?? {};
      const rev = Number(labels.rev);
      if (labels.run === run && labels.stage === stage && labels.kind === "gate" && rev > bestRev) {
        best = root;
        bestRev = rev;
      }
    }
    after = page.next_cursor;
  } while (after);
  return best;
}

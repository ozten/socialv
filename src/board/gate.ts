// The owner's typed replies at a gate (design section 6.1), parsed with code.
// A stand-in for Openboard's planned approval controls: delete it when they land.

export type GateDecision =
  | { kind: "approve"; /** Item numbers, or null for everything in the packet. */ items: number[] | null }
  | { kind: "revise"; notes: string }
  | { kind: "reject"; reason: string };

const APPROVE_ALL = /^approve$/i;
const APPROVE_ITEMS = /^approve\s+(\d+(?:\s*,\s*\d+)*)$/i;
const REVISE = /^revise\s*:\s*(\S[\s\S]*)$/i;
const REJECT = /^reject\s*:\s*(\S[\s\S]*)$/i;

/** Reads a decision out of a reply. Null when the reply is none of the four forms. */
export function parseGateReply(text: string): GateDecision | null {
  const trimmed = text.trim();
  if (APPROVE_ALL.test(trimmed)) {
    return { kind: "approve", items: null };
  }
  const items = APPROVE_ITEMS.exec(trimmed);
  if (items?.[1]) {
    const numbers = [...new Set(items[1].split(",").map((n) => Number(n.trim())))].sort((a, b) => a - b);
    if (numbers.some((n) => !Number.isSafeInteger(n) || n < 1)) {
      return null;
    }
    return { kind: "approve", items: numbers };
  }
  const revise = REVISE.exec(trimmed);
  if (revise?.[1]) {
    return { kind: "revise", notes: revise[1].trim() };
  }
  const reject = REJECT.exec(trimmed);
  if (reject?.[1]) {
    return { kind: "reject", reason: reject[1].trim() };
  }
  return null;
}

/** The decision written back in its canonical form, so `parseGateReply(formatGateDecision(d))` is `d`. */
export function formatGateDecision(decision: GateDecision): string {
  switch (decision.kind) {
    case "approve":
      return decision.items ? `approve ${decision.items.join(",")}` : "approve";
    case "revise":
      return `revise: ${decision.notes}`;
    case "reject":
      return `reject: ${decision.reason}`;
  }
}

/** The four reply forms, as a Markdown list. */
export const REPLY_FORMS = [
  "- `approve`: everything in the packet",
  "- `approve 1,3`: those items only",
  "- `revise: <notes>`: rework, with your notes",
  "- `reject: <reason>`: stop this run",
].join("\n");

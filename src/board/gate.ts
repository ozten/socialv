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
  "- `revise: <notes>`: rework, with your notes (a line per shot, `shot_03: <note>`, redoes only those shots)",
  "- `reject: <reason>`: stop this run",
].join("\n");

// ----- Notes for single shots -------------------------------------------------

const SHOT_NOTE = /^(shot_\d{2,})\s*:\s*(\S.*)$/;

/**
 * Rework notes that name shots, one `shot_03: what to fix` per line. Returns
 * the note for each shot, or null when the notes are not all in that form
 * (they then apply to every shot). A shot that is not named is kept as it is.
 */
export function shotNotes(notes: string | null | undefined): Map<string, string> | null {
  const lines = (notes ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const out = new Map<string, string>();
  for (const line of lines) {
    const match = SHOT_NOTE.exec(line);
    if (!match) return null;
    out.set(match[1]!, out.has(match[1]!) ? `${out.get(match[1]!)} ${match[2]!}` : match[2]!);
  }
  return out;
}

/** Notes per shot as a `revise` decision. A note's line breaks become spaces. */
export function reviseShots(notes: Record<string, string>): GateDecision {
  const lines = Object.entries(notes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([shot, note]) => `${shot}: ${note.replace(/\s+/g, " ").trim()}`);
  return { kind: "revise", notes: lines.join("\n") };
}

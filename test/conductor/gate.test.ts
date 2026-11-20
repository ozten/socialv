import { describe, expect, test } from "vitest";
import { formatGateDecision, parseGateReply } from "../../src/board/gate.ts";

describe("parseGateReply", () => {
  test("approve, any case, with whitespace around", () => {
    expect(parseGateReply("approve")).toEqual({ kind: "approve", items: null });
    expect(parseGateReply("  APPROVE \n")).toEqual({ kind: "approve", items: null });
    expect(parseGateReply("Approve")).toEqual({ kind: "approve", items: null });
  });

  test("approve with item numbers", () => {
    expect(parseGateReply("approve 1,3,4")).toEqual({ kind: "approve", items: [1, 3, 4] });
    expect(parseGateReply("approve 4, 1 ,3")).toEqual({ kind: "approve", items: [1, 3, 4] });
    expect(parseGateReply("approve 2,2")).toEqual({ kind: "approve", items: [2] });
    expect(parseGateReply("approve 0")).toBeNull();
    expect(parseGateReply("approve 1,")).toBeNull();
    expect(parseGateReply("approve all")).toBeNull();
  });

  test("revise and reject take text after a colon", () => {
    expect(parseGateReply("revise: make it louder")).toEqual({ kind: "revise", notes: "make it louder" });
    expect(parseGateReply("REVISE :  two lines\nof notes ")).toEqual({ kind: "revise", notes: "two lines\nof notes" });
    expect(parseGateReply("reject: off brand")).toEqual({ kind: "reject", reason: "off brand" });
    expect(parseGateReply("Reject:no")).toEqual({ kind: "reject", reason: "no" });
  });

  test("anything else is not a decision", () => {
    for (const text of ["", "lgtm", "approved", "approve!", "revise", "revise:", "revise:   ", "reject", "please approve", "reject - no"]) {
      expect(parseGateReply(text), text).toBeNull();
    }
  });

  test("format and parse round-trip", () => {
    for (const text of ["approve", "approve 1,3", "revise: louder", "reject: no"]) {
      const decision = parseGateReply(text)!;
      expect(parseGateReply(formatGateDecision(decision))).toEqual(decision);
      expect(formatGateDecision(decision)).toBe(text);
    }
  });
});

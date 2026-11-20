import { outputItems, type Pipeline } from "../pipeline.ts";

/** The M0 demo: a toy writer drafts, echo shouts it, the owner approves, echo stamps it. */
export function demoPipeline(topic = "a lighthouse keeper's first day off"): Pipeline {
  return {
    name: "demo",
    nodes: [
      {
        kind: "stage",
        name: "draft",
        role: "toy-writer",
        needs: [],
        summary: `Draft a short text about ${topic}.`,
        inputs: [],
        output: "out/draft.json",
        schema: "Text@1",
        params: { topic },
      },
      {
        kind: "stage",
        name: "shout",
        role: "echo",
        needs: ["draft"],
        summary: "Uppercase the draft.",
        inputs: ["out/draft.json"],
        output: "out/shout.json",
        schema: "Text@1",
        params: { op: "uppercase" },
      },
      {
        kind: "gate",
        name: "review",
        needs: ["shout"],
        title: "Approve the shouted text",
        summary: "The draft, uppercased. Approve it to have it stamped.",
        rework: ["draft", "shout"],
        items: outputItems,
      },
      {
        kind: "stage",
        name: "finish",
        role: "echo",
        needs: ["review"],
        summary: "Stamp the approved text.",
        inputs: ["out/shout.json"],
        output: "out/final.json",
        schema: "Text@1",
        params: { op: "stamp" },
      },
    ],
  };
}

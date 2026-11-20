import { afterAll, beforeAll, expect, test } from "vitest";
import { formatBrief, parseBrief } from "../../src/schemas/brief.ts";
import { startBoard, type TestBoard } from "./board.ts";

let tb: TestBoard;
beforeAll(async () => {
  tb = await startBoard();
});
afterAll(() => tb.stop());

test("a task kept for a role is claimed by that profile, and the owner posts as bare local", async () => {
  const conductor = tb.as("conductor");
  const text = formatBrief("Echo something", {
    v: 1, run: "r1", stage: "echo", role: "echo", output: "out/echo.json", schema: "Echo@1",
  });
  const { task } = await conductor.tasks.create("production/r1", { text, for: "echo" });

  const other = await tb.as("someone-else").tasks.claim({ channel: "production/" });
  expect(other).toBeNull();

  const claim = await tb.as("echo").tasks.claim({ channel: "production/" });
  expect(claim?.task.id).toBe(task.id);
  expect(parseBrief(claim!.task.text).role).toBe("echo");
  await claim!.complete("done");

  const reply = await tb.as(null).reply(task.id, "approve");
  expect(reply.by.handle).toBe("local");
  expect((await conductor.reply(task.id, "noted")).by.handle).toBe("local/conductor");
});

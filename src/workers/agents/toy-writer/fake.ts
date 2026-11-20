// The fake toy-writer: asks the director about tone, waits once, writes the
// sentence, or blocks the task when no answer comes. Knobs, read from the
// step's environment, for tests:
// - SOCIALV_FAKE_WAIT: seconds to wait for the answer (default: as the prompt says)
// - SOCIALV_FAKE_INVALID=1: write output that does not match the schema

import { BoardError, type Message } from "openboardlol";
import { localHandle } from "../../../config.ts";
import type { AgentTaskContext, FakeBehavior } from "../../types.ts";
import { mentionOf } from "../common.ts";
import { fakeBoard, withoutMentions, writeJson } from "../fake-kit.ts";
import { DIRECTOR } from "./prompt.ts";

export const fake: FakeBehavior = async (ctx, { env }) => {
  if (ctx.kind !== "task") {
    throw new Error("toy-writer works tasks only");
  }
  const write = async (tone: string | null) => {
    const topic = String(ctx.brief.params.topic ?? "something");
    let text = `${topic[0]?.toUpperCase() ?? ""}${topic.slice(1)}, told ${tone ?? "plainly"}.`;
    if (ctx.brief.notes) {
      text += ` (Reworked: ${ctx.brief.notes})`;
    }
    await writeJson(ctx.draftPath, env.SOCIALV_FAKE_INVALID === "1" ? { txt: text } : { text });
    return `Wrote a sentence about ${topic}.`;
  };

  if (ctx.retry) {
    return write(null);
  }
  if (ctx.resume) {
    return write(answerIn(ctx, ctx.resume.replies));
  }
  if (ctx.questionsLeft <= 0) {
    return write(null);
  }

  const me = fakeBoard(env, ctx.role);
  const question = `What tone should the sentence about ${String(ctx.brief.params.topic)} take?`;
  const asked = await me.reply(ctx.taskId, `${mentionOf(DIRECTOR)} ${question}`);
  const waitSecs = Number(env.SOCIALV_FAKE_WAIT ?? ctx.waitSecs);
  const event = await me.wait({ thread: ctx.taskId, mentionsMe: true, after: asked.cursor }, { timeout: waitSecs });
  if (event) {
    const thread = await me.thread(ctx.taskId);
    const answer = thread.replies.find((m) => m.id === event.message_id);
    return write(answer ? withoutMentions(answer.text) : null);
  }

  // No answer in time: hand the question to the creator and stop.
  try {
    await me.tasks
      .held(ctx.taskId, { epoch: Number(env.BOARD_TASK_EPOCH), token: env.BOARD_TASK_TOKEN ?? "" })
      .block(question, { kind: "needs_input" });
  } catch (error) {
    if (error instanceof BoardError && error.code === "claim_lost") {
      return "My claim was lost; stopping.";
    }
    throw error;
  }
  return "Blocked the task with my question.";
};

/** The latest reply to this role that is not its own. */
function answerIn(ctx: AgentTaskContext, replies: Message[]): string | null {
  const self = localHandle(ctx.role);
  const answers = replies.filter((m) => m.by.handle !== self);
  const last = answers[answers.length - 1];
  return last ? withoutMentions(last.text) : null;
}

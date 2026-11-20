// One of two gateway processes racing on the same action. Waits until a
// shared start time, then runs the paid path with a fake provider that
// appends a line to a file on every submit. Prints the outcome as JSON.
//   race-entry.ts <runDir> <projectDir> <taskId> <epoch> <submitsFile> <startAtMs>
import { appendFileSync } from "node:fs";
import type { Config } from "../../src/config.ts";
import { runPaidAction } from "../../src/gateway/action.ts";
import { SPEECH_TO_TEXT } from "../../src/gateway/prices.ts";
import { fakeTranscriber } from "../../src/gateway/transcribers.ts";

const [runDir, projectDir, taskId, epoch, submitsFile, startAt] = process.argv.slice(2) as [string, string, string, string, string, string];
const config = { projectDir, owner: "local", runtime: "fake" } as Config;
const t = fakeTranscriber({ submitDelayMs: 300, onSubmit: (id) => appendFileSync(submitsFile, `${process.pid} ${id}\n`) });
const input = { audio_sha256: "abc123abc123abc123", duration_sec: 12, diarize: true, tag_audio_events: true, audio_path: "analysis/audio.wav" };

await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
try {
  const out = await runPaidAction(
    { config, run: "race", runDir, taskId, epoch: Number(epoch), notify: { thread: async () => {}, ops: async () => {} } },
    {
      operation: "transcribe",
      endpoint: SPEECH_TO_TEXT,
      input,
      basis: { audio_sec: 12 },
      provider: { ...t, prepare: (ep) => t.prepare(ep, input) },
    },
  );
  process.stdout.write(JSON.stringify({ ok: true, replayed: out.replayed, request: out.row.request_id }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: (error as Error).message }));
}

// Stands in for a step: records which provider keys its environment holds,
// then exits non-zero so the task fails. `env-entry.mjs <outFile> <role>`
import { writeFileSync } from "node:fs";

const [out, role] = process.argv.slice(2);
const keys = ["FAL_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY"].filter((k) => process.env[k] !== undefined);
writeFileSync(out, JSON.stringify({ role, keys, task: process.env.BOARD_TASK ?? null }));
process.exit(1);

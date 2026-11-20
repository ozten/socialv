import type { Config } from "../config.ts";
import { claudeRuntime } from "./claude.ts";
import { fakeRuntime } from "./fake.ts";
import type { AgentRuntime } from "./runtime.ts";

export function selectRuntime(config: Config): AgentRuntime {
  return config.runtime === "fake" ? fakeRuntime : claudeRuntime;
}

// A stand-in for `bin/socialv step <role>` in tests, so the worker loop can be
// tested under the real `openboard tasks run` without depending on the CLI.
import { loadConfig } from "../../src/config.ts";
import { runStep } from "../../src/step/index.ts";

process.exit(await runStep(loadConfig(), process.argv[2] ?? ""));

// A stand-in for `bin/socialv step gateway` under the real worker loop. The
// fal transcriber looks for its key only in the project's secrets.env (not
// the environment, not the repository's .env), so a missing key is real and
// nothing can reach fal.
import { loadConfig } from "../../src/config.ts";
import { secretsFile } from "../../src/gateway/keys.ts";
import { falTranscriber, useTranscriber } from "../../src/gateway/transcribers.ts";
import { runStep } from "../../src/step/index.ts";

const config = loadConfig();
useTranscriber(() => falTranscriber(config.projectDir, {}, [secretsFile(config.projectDir)]));
process.exit(await runStep(config, process.argv[2] ?? ""));

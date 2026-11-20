# socialv

socialv makes short social videos with a team of agents. A deterministic
TypeScript conductor runs the pipeline as tasks on an
[Openboard](https://www.npmjs.com/package/openboardlol) board; tool workers and
language-model roles claim those tasks, ask each other questions in task
threads, and the owner approves each gate by replying on the board. Workers
sleep until there is work, so an idle pipeline makes no model calls. See the
[product requirements](docs/prd.md) and the
[engineering design](docs/engineering-design.md).

## Prerequisites

- Node 22 or later
- The `openboard` binary (0.3.0) on your `PATH`
- `claude` (Claude Code) on your `PATH`, for the real agent roles. Tests and
  `SOCIALV_RUNTIME=fake` do not need it.

## Quick start

```sh
npm install
npm test                      # unit and integration tests (needs openboard)
bin/socialv up --run demo-1   # board, review server, workers and the conductor
```

`up` starts a local board if none answers at `BOARD_URL`, then prints the
board's URL and the review server's URL. Open the board's web page, go to the
`gates/demo-1` channel, open the gate's review page from the packet, and reply
in the gate's thread with `approve`, `approve 1,3`, `revise: <notes>` or
`reject: <reason>`. Ctrl-C stops everything `up` started.

`bin/socialv --help` lists the other commands (`conductor`, `worker`,
`mentions`, `step`, `review`).

## Analysing a reference video

The `analysis` pipeline takes a reference video apart shot by shot:

```sh
cp ~/Movies/reference.mov projects/demo/source/original.mov
bin/socialv up --run ref-1 --pipeline analysis   # or --source source/other.mp4
```

It probes the video, transcribes it through the spend gateway while shots are
detected, has the `annotator` describe each shot from its keyframes (one task
per shot; it may ask `creative-director`, who rules from the project's
`brief.md`), and assembles `analysis/blueprint.json` and
`analysis/source_analysis.md` in `runs/ref-1/`. The `blueprint-review` gate
in `gates/ref-1` shows each shot's first frame beside what the system thinks
it shows: `approve` ends the run; `revise: <notes>` has every shot described
again with your notes.

The source is a path inside the project folder. Without `--source` it is the
`source` field of the project's `socialv.json`, else `source/original.mov`.
The first start records the pipeline and source in `runs/<run>/run.json`, so
restarting a run needs neither flag (and a different one is refused). Without
`--pipeline`, a new run uses the toy `demo` pipeline.

## Configuration

All settings come from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `BOARD_URL` | `http://127.0.0.1:7878` | Where the board listens |
| `BOARD_NAME` | the project folder's name | The board's name, one per project |
| `SOCIALV_PROJECT_DIR` | `projects/demo` | The project folder |
| `SOCIALV_OWNER` | `local` | The handle whose gate decisions are trusted |
| `SOCIALV_REVIEW_URL` | `http://127.0.0.1:7979` | Where the review server is reached |
| `SOCIALV_RUNTIME` | `claude` | Agent runtime: `claude`, or `fake` for tests |

`projects/` holds user artifacts (briefs, reference media, run output and the
local board's data) and is gitignored; nothing in it is ever committed.

## Provider keys

Paid calls (transcription now; image and video generation later) go through
one process, the spend gateway (`socialv worker --role gateway`, started by
`up`). It is the only process that reads provider keys. It looks for
`FAL_KEY` in this order:

1. its environment;
2. `<project>/secrets.env`, with a line `FAL_KEY=...` (the project folder is never committed);
3. `.env` in this repository's root (gitignored).

Prefer a file over exporting `FAL_KEY` in your shell: every other worker and
every agent session has provider keys stripped from its environment, but
`up` itself, the conductor and the review server inherit your shell's
variables. Without a key, a paid task fails with a reason naming the file to
create; the worker keeps running.

Spending caps live in `socialv.json` under `budget` (defaults shown):

```json
{ "budget": { "run_usd": 5, "day_usd": 10, "auto_approve_usd": 0.5 } }
```

An action that may cost more than `auto_approve_usd` is refused until the
approval gate is built. Creating `<project>/.socialv/stop-spend` stops all
spending. Every attempt is recorded in `runs/<run>/ledger.db` and
`runs/<run>/manifests/cost_log.csv`. Set `SOCIALV_TRANSCRIBER=fake` to
transcribe without the network (the default under `SOCIALV_RUNTIME=fake`).

## Using a network board

By default `up` starts a local board on loopback. To use a board that is
already running, such as a network board on your LAN:

1. On the board's host, invite an agent: `openboard invite socialv`.
2. Here, run `openboard join <invite>`. The login is stored by the
   `openboard` CLI, and socialv reads the same login.
3. Put the board and the owner in `projects/<project>/socialv.json`:

   ```json
   {
     "boardUrl": "https://192.168.64.1:7878",
     "boardName": "socialv-demo",
     "owner": "you@example.com"
   }
   ```

`owner` is the handle whose gate decisions are trusted. On a network board
it is the owner's email address, which the board verifies, so only that
signed-in person can approve. On a local board it is `local`, by convention.
Every socialv process posts as a profile of the enrolled agent, such as
`socialv/conductor`. The environment variables below override the file.

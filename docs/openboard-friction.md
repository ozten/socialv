# Openboard friction log

socialv is built on [Openboard](https://openboard.lol) partly to learn what
works and what hurts. This file is the record. It is reviewed at the end of
each milestone, and each entry ends as an upstream issue, a decision not to
raise one, or a note that Openboard already fixed it.

See the [engineering design](engineering-design.md#11-dogfooding-openboard)
for the rule on stand-ins: where a feature is on Openboard's roadmap, we
write the smallest workaround and delete it when the feature ships.

## How to add an entry

Add a row to **Observed** when the board makes something hard, surprising
or impossible. Write it at the time, with the Openboard version.

- **What we tried:** the command or call, and what we wanted.
- **What happened:** the output or error code.
- **What we did instead.**
- **Suggestion:** a change to Openboard, its docs or its skill file.
- **Status:** open, raised (with a link), fixed in a version, or dropped.

Good things count too: add them under **Worked well**, since they tell the
maintainers what to keep.

## Observed

| Date | Version | What we tried | What happened | What we did instead | Suggestion | Status |
|---|---|---|---|---|---|---|
| 2026-11-20 | 0.3.0 | From `socialv up`, wait until a board answers at a URL before starting workers. | No documented readiness check. `GET /v1/health` works but appears only in the hosted-board guide; `openboard --json version` reports `board.reachable` but exits 0 either way. | Poll `/v1/health`. | Document `/v1/health`, or add a command that exits non-zero when the board is unreachable. | raised: [openboard#6](https://github.com/ozten/openboard/issues/6) |
| 2026-11-20 | 0.3.0 | Print a link straight to a gate thread for the owner. | The web page supports `/?board=&channel=&thread=`, but no guide mentions it, the CLI prints no URL, and the SDK has no helper. One of our agents concluded deep links did not exist. | Tell the owner which channel to open; build the URL by hand later. | Document the format; add `url` to `post`, `reply` and `tasks create` output; add an SDK helper. | raised: [openboard#6](https://github.com/ozten/openboard/issues/6) |
| 2026-11-20 | 0.3.0 | Followed the SDK README: `import { board } from "openboard"`. | The package is named `openboardlol`, so that import does not resolve. | Import from `"openboardlol"`. | Fix the README examples to use the published name. | open |

## Worked well

| Date | Version | What | Why it helped |
|---|---|---|---|
| 2026-11-20 | 0.3.0 | The TypeScript SDK was published to npm as `openboardlol` the day we needed it. | No `file:` dependency on a sibling checkout. |

## Expected

Predictions from reading Openboard 0.3.0's code and docs on 2026-11-20,
before writing any socialv code. Move a row to **Observed** when it is
confirmed, and strike it when it turns out not to matter.

### On the roadmap already

| Expected friction | Our stand-in | Roadmap item |
|---|---|---|
| No attachments; 10,000-character messages; no remote images in markdown | Paths and digests in messages; a static review server | Attachments (Parity) |
| No signed or action-bound approvals | A typed owner reply checked against a request digest in our gateway | Signed approvals and approval tasks (Hardening) |
| Briefs and scorecards are JSON inside markdown | Validate on our side | Structured data (Parity) |
| No watchers or schedules | The conductor's event loop; no reminders | Watchers, schedules (Parity) |
| Nothing bounds an agent-to-agent conversation | A question counter in a label; a rule in the prompt | Budgets, circuit breakers, hop tracking (Parity) |
| A verified owner needs network mode and a certificate warning | Trust the bare `local` handle by convention | Trusted certificates, passkeys (People and production network) |
| Browser live updates pause in background tabs | None | HTTP/2 |
| No notification when a gate opens and the owner is away | None | Slack bridge |

### Not on the roadmap

| Expected friction | Our stand-in | Suggestion |
|---|---|---|
| A person cannot act on a task in the web page: no approve, unblock or claim control | Typed replies parsed by the conductor | Task actions for people |
| Only a task's creator can unblock it, so an answered question needs the conductor to notice and unblock | The conductor watches for replies that mention the asker | Let a holder block "until a reply from X" |
| A local board cannot tell people from agents | The owner is whoever posts with no profile | Identities on a local board, without TLS |
| The TypeScript SDK lacks the event stream, grants and `explain` | Long-poll; the CLI in a setup script | Add them to the SDK |
| Claude Code refuses commands that expand `$BOARD_TASK` | Write the task ID into the prompt | Known upstream; record how often agents still trip |
| A mention on a local board needs the `local/` prefix | Role prompts give the full handle | Record whether agents get it wrong |
| `tasks run` handles one task and exits | A shell loop around it | A `--loop` flag, if the loop proves fiddly |
| Leases last five minutes at most; renders last longer | `tasks run` renews | Probably fine; record renewal failures |
| Batches hold 15 tasks | `createTasksInChunks` | Record whether a long video hits it |
| Channel patterns are prefixes only | Channel layout puts the kind before the run | Record whether per-run derived tokens are enough |
| Ready claims need `from` on a network board | Workers will pass the conductor's name | Document the pattern for a service that creates work for others |

### Expected to work well

- Leased tasks with dependencies as the substrate for a pipeline.
- `blocked` as the human-in-the-loop state.
- Mentions as the way one agent wakes another.
- `tasks run` as the only runner we need.
- Idempotency keys for restart safety.
- Threads that read as a sensible record of who asked what and who decided.

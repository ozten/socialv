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
| 2026-11-20 | 0.3.0 | Start the conductor on a new board by listing its tasks. | `tasks.list`, `threads` and claims fail with `not_found` until something has been posted to the board. Every board test failed on its first run. | The conductor posts its "run started" line before reading anything; workers treat `not_found` as "retry". | Reads on an unknown board return empty, or add an explicit create call. | open |
| 2026-11-20 | 0.3.0 | Create a stage's tasks and its gate in one atomic batch. | `createMany` takes one channel; stages are in `work/<run>` and the gate in `gates/<run>`. | Two calls; the next pass repairs a crash between them. | Let a batch span channels. | open |
| 2026-11-20 | 0.3.0 | Approve a blocked gate as its creator. | Four steps: receipt, unblock, claim, complete. A crash between claim and complete loses the claim token and nobody can complete the gate until the lease ends. | Claim with the 5 s minimum lease. | A creator-only "complete with result" on a blocked or ready task. | open |
| 2026-11-20 | 0.3.0 | Unblock a `needs_input` task when its question is answered. | The board cannot say "an answer arrived after the question". We compare a reply's `created_at` with the task's `changed_at`; an answer that lands between the agent's wait timing out and its block is missed. `changed_at` moves on every transition, not only the block. | Timestamp comparison. | Unblock on a non-holder reply when the kind is `needs_input`, or let `block` take an `after` cursor; add `blocked_at`. | open |
| 2026-11-20 | 0.3.0 | Stop the conductor promptly on abort. | Only `poll`, `events`, `wait` and `claim` take an `AbortSignal`; `post`, `reply`, `tasks.*` and `label` do not. | Stop between passes. | Accept a signal on every SDK call. | open |
| 2026-11-20 | 0.3.0 | Follow one run's events. | A filter takes one channel or subtree; `work/<run>` and `gates/<run>` share no prefix. | Merge two `events()` generators. | Accept several channels in one filter. (Our kind-first layout causes this; it exists to suit prefix grants.) | open |
| 2026-11-20 | 0.3.0 | Keep a gate's decision where a restart can read it. | The only durable place is free text: the cancel reason, parsed back. | Parse the reason. | Covered by planned structured data and approval tasks. | open |
| 2026-11-20 | 0.3.0 | Decide whether a reply is newer than the packet. | IDs and cursors are opaque, and no doc states that replies in a thread come back in posting order. | Rely on reply order. | Document the ordering guarantee. | open |
| 2026-11-20 | 0.3.0 | Pick a lease and an idempotency key. | The skill file does not give the lease bounds (5 to 300 s) or the 255-byte key limit; both came from the server source. | Read the source. | Add both to the skill file and SDK types. | open |
| 2026-11-20 | 0.3.0 | Match a mention against an author. | `@local/toy-director` comes back as `{handle: "local", profile: "toy-director"}`, but an author's `by.handle` is `"local/toy-writer"`. | Two different comparisons. | One shape for a handle in both places. | open |
| 2026-11-20 | 0.3.0 | Have an agent ask a question, then wait for the answer. | `wait --thread --mentions-me` without `--after` can miss a fast answer. The skill says to pass the cursor, but its `tasks run` section shows a reply then a wait with none. | Our role prompt tells the agent to pass `--after`. | Fix the example in the skill file. | open |
| 2026-11-20 | 0.3.0 | Know when `events()` is listening. | With no cursor it starts "from now", and the first long-poll begins only when iteration starts, so a post made straight after can be missed. | Poll once for a cursor and persist it. | Return the start cursor, or a ready callback. | open |
| 2026-11-20 | 0.3.0 | Log what `tasks run` did with each task. | No machine-readable outcome. Exit code 1 means nothing ready, timeout, claim lost, unreachable, or a failed command. | Parse stderr with a regular expression. | A `--json` line per task: id, final state, command exit code. | open |
| 2026-11-20 | 0.3.0 | Read a two-line task result with `tasks show`. | The newline inside the result renders as U+FFFD. The stored result is correct. | None. | Render or escape newlines in results. | open |
| 2026-11-20 | 0.3.0 | Settle a task from inside `tasks run` with the SDK. | It works through `tasks.held(id, {epoch, token})` with `BOARD_TASK_EPOCH` and `BOARD_TASK_TOKEN`, but neither the skill nor `--help` says so. There is also no helper for "is this claim still mine". | Found it in the type definitions; compare state, epoch and holder by hand. | Document it; add a claim check to the SDK. | open |
| 2026-11-20 | 0.3.0 | Let a Claude Code agent run `wait --timeout 4m`. | Claude Code's Bash tool times out at 2 minutes by default. The skill warns about 10-minute harness caps but not this one. | Set `BASH_DEFAULT_TIMEOUT_MS` for the session. | Mention the 2-minute default in the skill. | open |
| 2026-11-20 | 0.3.0 | Create a task with a multi-line brief from a shell. | `tasks create` takes the brief as an argument; `--file` is only for JSON plans. | Use the SDK. | Read the brief from stdin, as `post` does. | open |
| 2026-11-20 | 0.3.0 | Use the SDK on a network board after `openboard join`. | The SDK reads only `BOARD_TOKEN` and `BOARD_FINGERPRINT`; it does not use the login the CLI stored. A process started by `tasks run` gets `BOARD_URL` and `BOARD_LOGIN` but no token. | Read `~/.config/openboard/logins.json` ourselves. | Let `board()` use the stored login, as the CLI does. | open |
| 2026-11-20 | 0.3.0 | Reuse a saved event cursor after pointing a project at another board. | `the cursor was not issued by this board`. Correct, but nothing in a cursor says which board it is for. | Key our cursor files by board URL and name. | None needed; note it in the SDK docs. | open |
| 2026-11-20 | 0.3.0 | Clear out a test board: six channels, 13 threads, 23 messages. | `delete` tombstones one message at a time and needs the author's profile. Nothing removes a thread, a channel or a board, so the empty channels and the board stay listed. | Deleted every message by script, then moved to a new board. | Delete or archive a thread, a channel and a board; a `delete --thread` at least. | raised: [openboard#8](https://github.com/ozten/openboard/issues/8) |
| 2026-11-20 | 0.3.0 | Followed the SDK README: `import { board } from "openboard"`. | The package is named `openboardlol`, so that import does not resolve. | Import from `"openboardlol"`. | Fix the README examples to use the published name. | open |

## Worked well

| Date | Version | What | Why it helped |
|---|---|---|---|
| 2026-11-20 | 0.3.0 | The TypeScript SDK was published to npm as `openboardlol` the day we needed it. | No `file:` dependency on a sibling checkout. |
| 2026-11-20 | 0.3.0 | Idempotency keys on posts and task creation. | A retry returns the original with `duplicate: true`. A conductor killed at any write, 40 times over, never duplicated a task or message. |
| 2026-11-20 | 0.3.0 | Conditional labels. | The retry counter is safe to repeat without a store of our own. |
| 2026-11-20 | 0.3.0 | `tasks.needs` re-pointing, and `for` routing with ready claims. | Rework re-points open tasks instead of recreating them; a test worker is about ten lines. |
| 2026-11-20 | 0.3.0 | `board({ fetch })`. | Crash injection in tests: fail the Nth write before or after the board takes it. |
| 2026-11-20 | 0.3.0 | `openboard tasks run` as the only runner. | It renewed leases, settled by exit code, and left alone a task the step had blocked or completed itself. We wrote no claim or lease code. |
| 2026-11-20 | 0.3.0 | A Claude agent using the CLI for the first time. | In the real run the writer asked the director by mention, waited once and got the answer in about five seconds. Neither session had a failed board command. |
| 2026-11-20 | 0.3.0 | `wait --mentions-me --after` and the delimited output of `read` and `wait`. | A cheap one-shot wake, and output the agent read without trouble. |
| 2026-11-20 | 0.3.0 | Moving the demo from a local board to a network board. | No change to the pipeline: tasks, `for` routing, mentions and `tasks run` behaved the same. The owner check became a verified one, since the board stamps the person's email on their replies. |

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

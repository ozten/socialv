# socialv: product requirements

**Status:** draft for review · **Date:** 2026-11-20 · **Companion:** [engineering design](engineering-design.md)

## 1. Summary

socialv turns a **production brief** and a **reference video** into a finished
vertical social video. A team of agents does the analysis, writing, prompt
construction and editing. A person approves every expensive step before it
runs and reviews its output afterwards. The agents and the person coordinate
through an [Openboard](https://openboard.lol) board.

The project has two goals of equal weight:

1. **Dogfood Openboard.** Run a real multi-agent workflow with human approval
   gates on it, and record what works and what hurts.
2. **Automate social video production.** Take a workflow that today is a long
   manual checklist and make it a repeatable run that a person steers from a
   browser.

## 2. Guiding principle

> Expensive steps such as video generation have guardrails, and a human
> review step before and after.

Everything else follows from it. Agents can read, write, analyse and propose
freely. They cannot spend money. Spending goes through one gateway, which
acts only on a person's recorded approval of the exact request.

## 3. Users

| Who | What they do |
|---|---|
| **Producer**, the run's **owner** (one person at first) | Writes the brief, supplies the reference video and brand assets, approves and reviews at each gate, takes the final video and uploads it. |
| **Operator** (the same person at first) | Runs the board and the socialv processes, sets budgets, reads the cost log. |
| **Openboard maintainers** | Read the friction log and decide what to build next. |

## 4. Inputs: the project is a user artifact

A **project** is a folder the producer owns. It is not part of this
repository and is never committed to it.

- **Brief** (`brief.md`): what to make. It holds the transformation rules
  (what in the reference is replaced by what), the creative look, the
  truthfulness and rights constraints, and the quality checklist for a shot.
- **Reference video**: the video whose hook, pacing, shot structure and
  camera language the new video follows.
- **Brand kit**: product photos, actor or character references, environment
  references, label artwork, a sheet of verified product claims.
- **Budget**: a spending cap for the run, and limits per shot.

The system is generic. Nothing in the code names a brand, a product or a
setting. Those come from the brief.

## 5. The run, from the producer's side

1. The producer starts a run for a project, from the command line or by
   posting in the board's intake channel.
2. Agents analyse the reference: transcript with timings, shot list,
   keyframes, a description of each shot. No approval is needed; this costs
   cents.
3. Agents adapt the creative: a new script, a replacement map per shot, and
   a list of claims that need substantiation.
4. **Gate: creative approval.** The producer reads the script, the map and
   the flagged claims, and approves, asks for changes or rejects.
5. Agents prepare reference assets and write a prompt per shot.
6. **Gate: test spend.** The producer sees one short test segment, the exact
   requests that would be sent, and the estimated cost. They approve.
7. The gateway renders the test candidates.
8. **Gate: test review.** The producer compares the candidates and chooses a
   generation method per shot.
9. **Gate: batch spend.** The producer sees every shot's request and the
   total estimate, and approves all or some.
10. The gateway renders the approved shots. A judge scores each take
    against the brief's checklist and writes a scorecard.
11. **Gate: take review.** For each shot the producer selects a take, asks
    for a retry with notes, or drops the shot. A retry is new spending and
    returns to step 9 for that shot.
12. Agents produce the voiceover, captions and the assembled cut.
13. **Gate: final review.** The producer approves the cut or sends it back.
14. The system packages the deliverables: the video, the manifests and the
    cost log. The producer uploads the video by hand.

The producer does all of this from the board's web page and the review
pages it links to. They are mentioned when a gate opens, and nothing
proceeds past a gate until they answer.

Between gates the agents work in the open. Each task has a thread on the
board where its agent posts progress. Agents ask each other questions
there: the script writer asks the creative director whether a line fits the
brand voice, and the answer appears in the same thread. The producer can
read any thread, answer a question themselves, or mention an agent to
redirect it.

## 6. Requirements

### 6.1 Workflow

- **W1.** A run produces a 9:16 MP4, a transcript and adapted script, a
  timecoded shot list, per-shot prompts and references, a generation
  manifest and a cost log.
- **W2.** Every stage's output is a file with a defined schema, so a stage
  can be rerun alone.
- **W3.** A run survives a restart of any process, including the board,
  without repeating finished work or repeating a paid request.
- **W4.** The producer can send any stage back with notes. Only that stage
  and what depends on it rerun.
- **W5.** The generation method is chosen per shot, not per run.
- **W6.** Exact on-screen text, captions and label artwork are added in the
  edit, not asked of the video model.

### 6.2 Guardrails on spending

- **G1.** Only the spend gateway holds provider credentials. No agent
  process has them.
- **G2.** A paid request above the auto-approve threshold runs only after a
  person approved that exact request: endpoint, inputs, parameters and cost
  ceiling. Changing any of them voids the approval.
- **G3.** An approval is used once.
- **G4.** Hard caps apply regardless of approvals: per run, per shot (retry
  count) and per day. Reaching a cap stops spending and alerts the producer.
- **G5.** All video is generated at 720p, to keep cost down. There is no
  separate final-resolution render.
- **G6.** Every attempt is logged with its request, job ID, cost and
  outcome, whether or not the take is used.
- **G7.** A request whose outcome is unknown after a crash is reconciled
  with the provider. It is never silently sent again.
- **G8.** Small paid calls (speech-to-text, a keyframe image, text-to-speech)
  below a configured threshold need no gate, but count against the caps and
  appear in the log.

### 6.3 Human review

- **H1.** A gate shows the producer what they are approving: the text, the
  images or video, the requests and the cost.
- **H2.** An approval counts only when it comes from the owner's handle,
  which is set in local configuration. While we run a local board this is
  trust by convention, since a local board does not verify authors; it
  becomes a verified check on a network board with no change to the
  workflow.
- **H3.** A gate can be approved in part ("shots 1, 3 and 4").
- **H4.** A gate left unanswered costs nothing. No process spends tokens
  while it waits.

### 6.4 Agents that talk to each other

- **A1.** An agent can ask another agent role a question in its task's
  thread and receive the answer in the same session when the answer is
  quick.
- **A2.** A question that is not answered quickly parks the task at no
  cost; the task resumes with its context when the answer arrives.
- **A3.** An advisory role, the creative director, holds the brief's intent
  and answers such questions consistently across a run. Its rulings are
  written to a decision log.
- **A4.** Conversations are bounded: a limit on questions per task, and
  advisory roles do not consult other agents.
- **A5.** The owner can read every conversation, answer in place of an
  agent, and address any agent by mention.

### 6.5 Judges

- **J1.** Every rendered take is scored by at least one multimodal judge
  that watches the video itself. The first is Gemini.
- **J2.** A scorecard has pass or fail checks and 1 to 5 scores, each with
  evidence, built from the brief's quality checklist.
- **J3.** Judges advise. They do not select takes or cause spending. The
  owner sees every take, ordered by score.
- **J4.** The owner's decisions are logged against the scores, so that we
  can measure how often a judge agrees with the owner.
- **J5.** Adding a judge, for video or for another artifact such as the
  script, needs no change to the pipeline.

### 6.6 Truthfulness and rights

- **T1.** The adaptation stage flags every product claim and checks it
  against the claims sheet. Unsupported claims block creative approval until
  the producer resolves them.
- **T2.** Source audio, music, watermarks and branding from the reference
  are never carried into the output.
- **T3.** Before a real person's likeness is uploaded to a provider, the
  gate packet says so and names the reference files.

### 6.7 Dogfooding Openboard

- **D1.** All coordination between processes goes through the board: work
  hand-off, questions, approvals, status. No side channel.
- **D2.** We start on a local board, for speed. Channels are laid out so
  that a later move to network mode with grants needs no renaming.
- **D3.** A friction log records every place the board made something hard,
  with what we did instead. It is reviewed at the end of each milestone.
- **D4.** Agents use the `openboard` CLI and skill themselves. For each
  task we record board commands run, which failed and why, and tokens
  spent, as evidence of how the agent-facing surface holds up.

### 6.8 Efficiency

- **E1.** No language model is invoked to poll or check status. An agent
  may wait once, briefly, for an answer to its own question.
- **E4.** Agent roles run on `claude -p` under the owner's subscription by
  default. Other runtimes and models plug in per role, with their own
  keys.
- **E2.** Deterministic work (probing, scene detection, transcription,
  rendering, editing) is code, not an agent.
- **E3.** An agent session starts with the brief and pointers to files, not
  a replay of board history.

## 7. Not in scope for the first version

- Posting to TikTok, Instagram or any platform. The producer uploads.
- Several producers, roles or approval policies beyond a single owner.
- Verified identities and per-agent permissions on the board. They arrive
  with network mode, after the first full run.
- Judges with authority to select takes or trigger retries.
- A custom web application. The board's page and static review pages are
  the interface.
- Video providers other than fal.ai, and models other than Seedance 2.5.
- Lip-sync passes, music generation, and automatic A/B testing of creative.
- Cloud deployment. Everything runs on the producer's machine, with the
  option of workers on other machines later.

## 8. Success measures

| Measure | Target for the first full run |
|---|---|
| Paid requests sent without a matching approval | 0 |
| Paid requests sent twice for one approval | 0 |
| Language-model tokens spent while waiting on a person or a render | 0 |
| Spend against the approved budget | At or under |
| Producer time at gates, per run | Measured; baseline for later |
| Share of takes the producer selects first time | Measured; baseline for later |
| Agreement between the video judge and the producer | Measured; baseline for later |
| Agent questions answered without the producer | Measured; baseline for later |
| Friction log entries with an upstream issue or decision | All of them |

## 9. Milestones

| # | Name | Done when |
|---|---|---|
| M0 | Board and skeleton | A fake pipeline runs on a local board; one agent asks another a question and gets an answer in the thread; a gate is approved from the browser; idle processes spend no tokens. |
| M1 | Analysis | A reference video becomes a transcript, shot list, keyframes and annotated blueprint that the producer finds accurate. |
| M2 | Adaptation and one test render | Creative approval, then one approved test segment rendered two ways through the gateway, scored by the video judge, reviewed, and a method chosen. |
| M3 | Full run | Every shot rendered, judged and reviewed, the cut assembled, the final gate passed, deliverables packaged. |
| M4 | Learnings | Network mode with grants and a verified owner; friction log reviewed with Openboard; decisions on what to send upstream. |

M0 to M2 use a short reference clip and a small budget, so mistakes are
cheap.

## 10. Risks

| Risk | Response |
|---|---|
| The video model cannot hold the product's shape or label. | Test gate before the batch; label and text composited in the edit; method chosen per shot. |
| Provider rules restrict uploads of real people. | Check the endpoint's rules in M2 before any actor reference is uploaded; the brief can specify a generated character. |
| Provider schemas and prices change. | The gateway reads the live schema and a price table we maintain, and refuses a request it cannot price. |
| Approvals on a local board are unverified plain messages. | Accepted while dogfooding. Bind approvals to a digest of the request, accept them only from the owner's handle, and keep the provider key away from agents. Move to network mode in M4; revisit when Openboard ships signed approvals. |
| Agents talking to agents run away in tokens. | Wait once then park; a question budget per task; advisory roles cannot consult other agents. |
| A judge is confidently wrong. | Judges only advise; every take reaches the producer; agreement with the producer is measured before a judge is given authority. |
| Agent sessions share the subscription's rate limits with the owner's own use. | Cap concurrent sessions; record usage per session; a role can move to an API key. |
| The board has no file attachments. | Files stay on disk; messages carry paths and digests; a local review server shows media. Logged as friction. |
| Agent output drifts from the schema. | Validate every output; one automatic retry; then the task blocks for a person. |

## 11. Open questions

1. **Other agent runtimes.** Agent roles start on `claude -p` under the
   subscription, and the video judge on Gemini with an API key. Which
   other runtimes and judges do we want to try, and for which roles?
2. **Speech-to-text provider.** The design proposes ElevenLabs Scribe
   through fal.ai, so no new account is needed, with OpenAI as the
   fallback. Confirm after a side-by-side on one reference clip in M1.
3. **Voiceover.** Recorded by a person, or generated? If generated, which
   voice, and under what licence?
4. **Automatic retries.** The first version asks the producer before every
   re-render. Should an approval be able to cover "up to N attempts per
   shot" once the judge's agreement with the producer is high enough?
5. **Where the board runs.** Loopback on the producer's machine at first.
   A LAN address is needed once a worker runs on another machine.

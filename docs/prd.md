# socialv: product requirements

**Status:** draft for review · **Date:** 2026-11-20 · **Companion:** [engineering design](engineering-design.md)

## 1. Summary

socialv turns a **reference video** and a **production brief** into a new
vertical social video made with generative AI. A person works in a small
web app built around two tasks: **import** a video into a project, and
**render** the project, scene by scene. A team of agents does the analysis,
writing, prompt construction and editing behind those tasks. The person
approves every expensive step before it runs and reviews its output
afterwards. The agents coordinate through an
[Openboard](https://openboard.lol) board.

The project has three goals:

1. **Make one real video, somewhat by hand.** Produce a social video for
   Saturday House, doing by hand whatever is not built yet, so that we learn
   the workflow from a real job rather than from a plan.
2. **Codify that workflow into a lasting agent swarm.** Turn what we did
   into socialv: an app and a set of agents that make social videos with
   generative AI, for any brand, repeatably.
3. **Dogfood Openboard.** Use it as the backbone for the swarm and its
   orchestration, and record what works and what hurts.

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

## 5. The product: projects, import and render

The producer works in socialv's own web app. It is organised around tasks,
not around channels or pipelines.

### Home

A grid of project tiles in two groups, **Active** and **Archive**. A tile
shows the project's name, a frame from its video and where it stands. A
project can be moved between the two groups at any time. Importing a video
creates a new project in Active.

### Import a video into a project

The producer picks a reference video and gives the brief: what to make and
what replaces what. Import analyses the video and produces the project's
working artifacts:

- **Analysis** of the reference: transcript with timings, scenes, keyframes
  and a description of each scene.
- **Script**: the new dialogue and on-screen text, scene by scene.
- **Creative director notes**: the look, the tone, the rules for this video
  and every ruling made along the way.
- **Storyboard**: for each scene, what is shown and how it is filmed, beside
  the reference frames it replaces.
- **Character sheet**: who appears, how they look, and the reference images
  that keep them consistent.
- **Project settings**: the voice (for example an ElevenLabs voice), the
  aspect ratio, the budget, the product and brand assets.

Import costs cents and needs no approval before it runs.

### Iterate on the artifacts

Every artifact can be read and changed before anything is rendered. The
producer edits it directly or asks for a change in words ("make the opening
line shorter", "she should wear a navy jacket"), and the agent that owns
the artifact revises it. Changes to one artifact flow to the ones that
depend on it: a script change updates the storyboard for that scene.

### Render the project, scene by scene

Rendering produces a new 720p video. It is the expensive part, so it is
done one scene at a time, with the cost shown and approved before anything
is sent.

- The producer renders one scene, several, or all of them.
- Each render of a scene is a **version**. A scene can be rendered again as
  often as the producer asks, with or without notes. Earlier versions are
  kept.
- **Review a scene:** watch its versions beside the reference scene, with a
  judge's scorecard, then pick one, ask for another with changes, or drop
  the scene.
- **Review the whole piece:** the picked versions edited together with the
  voiceover and captions, watched as one video. The producer accepts it or
  sends scenes back.
- A project can be rendered to a full video more than once. Each full video
  is kept as an output.

### What a project keeps

- Its input video.
- Its artifacts, with their history.
- Every scene version and every output video.
- The one output chosen as **gold**: the final video.
- What was spent, request by request.

### Where the board fits

The app is how the producer does the work. The board is how the agents do
theirs, and the record of what happened. Every import and render is a set
of tasks on the board; every agent question, every approval and every paid
request is a message there. The app shows a link from any scene or artifact
to its thread, and the producer can read or join any conversation on the
board. Nothing in the app happens without a matching record on the board.

### The order of work underneath

1. Analyse the reference. No approval needed.
2. Adapt the creative: script, notes, storyboard, character sheet, and a
   list of claims that need substantiation.
3. **Approval: creative.** The producer accepts the artifacts or changes them.
4. Prepare reference assets and write a prompt per scene.
5. **Approval: spend.** The producer sees the exact requests and the
   estimated cost for the scenes they asked to render.
6. The gateway renders the approved scenes. A judge scores each version.
7. **Review: scenes.** Pick, re-render with notes, or drop. A re-render is
   new spending and returns to step 5 for that scene.
8. Produce the voiceover and captions, and assemble the cut.
9. **Review: the whole piece.** Accept it, or send scenes back.
10. Mark an output as gold. The producer uploads it by hand.

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
- **H5.** The producer makes every decision in the app by clicking: approve
  a cost, pick a version, ask for a re-render with notes, drop a scene,
  accept the cut, mark gold. The app records each decision on the board, in
  the thread it belongs to, before anything acts on it.
- **H6.** The app shows a project at a glance: which artifacts exist, each
  scene's state, what is waiting on the producer, and spend against the
  caps.

### 6.3a The app

- **U1.** The home page lists projects as tiles under Active and Archive.
  A project can be moved between them.
- **U2.** Importing a video creates an Active project and starts its
  analysis and first artifacts.
- **U3.** A project page shows the input video, each artifact, the scenes,
  the outputs and the gold video.
- **U4.** Any artifact can be edited directly or revised by request, and
  its earlier states can be seen.
- **U5.** Scenes are rendered one at a time or in a chosen set. Each render
  is kept as a version of its scene.
- **U6.** A scene's versions can be watched beside the reference scene.
- **U7.** The assembled piece can be watched as a whole, and rendered more
  than once.
- **U8.** One output can be marked gold; the mark can be moved.
- **U9.** All video is generated at 720p.
- **U10.** The app runs on the producer's machine and is reachable only
  from it.

## 7. Not in scope for the first version

- Posting to TikTok, Instagram or any platform. The producer uploads.
- Several producers, roles or approval policies beyond a single owner.
- Verified identities and per-agent permissions on the board. They arrive
  with network mode, after the first full run.
- Judges with authority to select takes or trigger retries.
- A second place for conversations. The app has no chat of its own; agent
  questions and answers stay on the board, and the app links to them.
- A video editor. The app reviews and re-renders scenes; it does not trim,
  reorder or grade footage by hand.
- Accounts, sharing and several producers in the app.
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
| M0 | Board and skeleton (done) | A fake pipeline runs on a board; one agent asks another a question and gets an answer in the thread; a gate is approved from the browser; idle processes spend no tokens. |
| M1 | Analysis (done) | A reference video becomes a transcript, scene list, keyframes and annotated blueprint that the producer finds accurate. |
| M2 | The Saturday House video, by hand where needed | The first real video exists: script, notes, storyboard and character sheet written; one scene test-rendered and reviewed; every scene rendered at 720p through the gateway; the cut assembled; a gold video chosen. Each step that was done by hand is written down as a step to codify. |
| M3 | The app, on the project model | Home with Active and Archive tiles; import creates a project and its artifacts; a project page shows artifacts, scenes, versions, outputs and gold. Built against the Saturday House project's real files. |
| M4 | The swarm does it | Import and render run end to end from the app for a second video, with agents doing every step that M2 did by hand, a judge scoring versions, and decisions recorded on the board. |
| M5 | Learnings | Network mode with grants and a verified owner; friction log reviewed with Openboard; decisions on what to send upstream. |

M2 starts with one test scene and a small budget, so mistakes are cheap.

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

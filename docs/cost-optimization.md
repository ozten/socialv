# Cost optimization

What we have learned about where the money goes when generating a social
video, and what to do about it. Add to this as we learn more. Prices are
dated because they change.

## What things cost

Read from the providers' pages on 2026-11-21.

| What | Provider and model | Price |
|---|---|---|
| Video, 720p | fal, Seedance 2.5 (`reference-to-video`, `image-to-video`) | about $0.473 per generated second; audio included |
| Video, 720p, Flash tier | fal, Seedance 2.5 Flash | about $0.302 per generated second (not tried yet) |
| Video, 480p | fal, Seedance 2.5 | about $0.2205 per generated second |
| Reference image | fal, Nano Banana Pro (edit) | $0.15 per image |
| Transcription | fal, ElevenLabs Scribe | $0.03 per audio minute |
| Voiceover | ElevenLabs, by subscription | characters from the plan's allowance (481 for the full script) |
| Scene description | Claude Sonnet, one session per shot | about $1.54 for 20 shots |

Video is nearly all of the cost. One pass over a 35 to 40 second video at
720p is about $19; everything else for the same video is under $3.

## Findings

### 1. Seedance's minimum take is 4 seconds, so group short scenes into one take

Seedance 2.5 will not generate less than 4 seconds, and bills every second
it generates. The reference video has 20 scenes, most between 0.6 and 2
seconds long. Rendering each scene as its own take would mean 20 takes of at
least 4 seconds: 80 seconds or more, about $38, of which more than half
would be thrown away in the edit. So rendering 20 short scenes one by one
would cost about double.

What we do instead: group consecutive scenes into one take with cuts inside
it, described shot by shot with timings in the prompt. The Saturday Wash
video is 8 takes totalling 48 seconds (about $22.70) rather than 20 takes.

The trade-off: a grouped take is all or nothing. If one shot inside it is
wrong, the whole take is paid for again. Group scenes that share a setting
and a subject, and keep takes with a speaking presenter separate from
hands-only takes.

Status: it works. Seedance followed timed shot lists of up to six shots in
one take, with hard cuts at roughly the asked times. Two things to plan for:
the cuts land up to half a second off the asked time (find them with scene
detection before editing), and one shot in a grouped take can ignore an
instruction (the tape appeared in a shot that asked for none), so write the
edit to be able to drop a shot.

### 2. Let the voiceover set the take lengths

A take has to be as long as its spoken line. Lauren reads the full script in
37.8 seconds, against a 30 second reference, and scene 6 alone is 6.6
seconds against 3.8. Every extra second of speech is $0.47 of video. Tighten
the script before rendering, not after.

### 3. Test one take before the batch

The first take (scene 6, $3.31) showed that the reference images hold the
presenter, the bottle and the setting. That was worth knowing before
spending $19 on the rest.

### 4. Fix the references once, as images

A reference sheet costs $0.15 and is reused by every take: presenter, bottle,
boat, and the bench before and after. This is cheap next to a single wasted
take caused by the model inventing a different boat.

### 5. Make the before and after obviously different in the reference images

The first reveal take ($5.20) was wasted: the "before" and "after" bench
images were nearly the same and the prompt asked for a "modest" difference,
so both halves of the seat came out identical. Fixing it meant re-rendering
three takes ($11.35) so the dirt matched across them. Before rendering any
before-and-after, put the two reference images side by side at phone size;
if the difference is not obvious there, it will not be in the video. Give
the reveal take an image of the end state as well as the start state.

### 6. Text is cheaper in the edit than in the model

The phone's caller name, the caption and the end card were added in the
edit with tracking and overlays, at no provider cost. The generated product
label was good enough to keep as rendered; replacing it was not worth doing.

### 7. A lip-synced take carries its own audio

Seedance re-voices the reference line with its own timing rather than
playing the recording back. In the edit, use the take's own audio for
speaking shots and the recorded voiceover only over the others; laying the
recording over a speaking take puts the lips out of sync.

### What the first video cost

Saturday Wash, 42.5 seconds: $34.07 through the gateway (11 takes, 72
generated seconds, of which 24 seconds were the redo) plus $0.75 for five
reference images. Renders took 4 to 9 minutes per take, one at a time.

## Ideas not tried yet

- **Flash tier for hands-only takes.** About 36% cheaper per second. Worth
  one comparison take.
- **480p drafts.** Less than half the price; Seedance has a draft mode that
  can be completed at a higher resolution later. Could be used to check a
  shot list before paying for 720p.
- **Fewer, longer takes versus more, shorter ones.** Measure how often a
  grouped take needs a redo; that decides the best group size.
- **Trim the script to the reference's length** before the voiceover is
  generated.

## How spending is controlled

- Caps in the project's `socialv.json`: per run, per day, and the largest
  request that needs no approval.
- Every video request is priced and shown for approval before it is sent;
  the gateway sends only what was approved, unchanged.
- `manifests/cost_log.csv` in the run folder records every paid request.

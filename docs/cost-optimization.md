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

Status: the grouping is in the first full render plan (`full-1`). Whether
Seedance follows a timed shot list well enough is not yet known.

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

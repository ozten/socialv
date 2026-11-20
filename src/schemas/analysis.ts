// Artifacts of the analysis stages: what reverse-engineering a reference
// video produces. Times are seconds from the start of the reference video.
// Paths are relative to the run folder.

import { z } from "zod";

const sec = z.number().nonnegative();

/** `analysis/probe.json`: what the reference video is, technically. */
export const Probe = z
  .object({
    duration_sec: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    /** Display rotation in degrees, already applied to width and height. */
    rotation: z.number().int(),
    orientation: z.enum(["portrait", "landscape", "square"]),
    video_codec: z.string(),
    audio: z.object({ codec: z.string(), sample_rate: z.number().int().positive(), channels: z.number().int().positive() }).nullable(),
    /** The extracted audio (mono 16 kHz WAV), or null when the video has no audio track. */
    audio_path: z.string().nullable(),
    size_bytes: z.number().int().nonnegative(),
  })
  .strict();
export type Probe = z.infer<typeof Probe>;

/** `analysis/transcript.json`: speech with word timings, and tagged non-speech sounds. */
export const Transcript = z
  .object({
    language: z.string().nullable(),
    text: z.string(),
    words: z.array(z.object({ text: z.string(), start_sec: sec, end_sec: sec, speaker: z.string().nullable() }).strict()),
    /** Non-speech sounds the transcriber tagged, such as music or laughter. */
    events: z.array(z.object({ label: z.string(), start_sec: sec, end_sec: sec }).strict()),
    provider: z.string(),
    model: z.string(),
  })
  .strict();
export type Transcript = z.infer<typeof Transcript>;

/** `analysis/shots.json`: shot boundaries and the frames pulled from each shot. */
export const Shots = z
  .object({
    shots: z
      .array(
        z
          .object({
            /** `shot_01`, `shot_02`, in order. */
            shot_id: z.string().regex(/^shot_\d{2,}$/),
            start_sec: sec,
            end_sec: sec,
            keyframes: z.array(
              z.object({ path: z.string(), time_sec: sec, reason: z.enum(["start", "middle", "end", "motion"]) }).strict(),
            ),
          })
          .strict(),
      )
      .min(1),
    detector: z.object({ method: z.string(), threshold: z.number() }).strict(),
  })
  .strict();
export type Shots = z.infer<typeof Shots>;

/** `analysis/annotations/<shot_id>.json`: what one shot shows and does. Written by the annotator. */
export const ShotAnnotation = z
  .object({
    shot_id: z.string(),
    /** What the shot is for in the ad: hook, product reveal, demonstration, call to action. */
    purpose: z.string().min(1),
    framing: z.string().min(1),
    camera_motion: z.string().min(1),
    subjects: z.array(z.string()),
    /** The action, as ordered beats. */
    action_beats: z.array(z.string()).min(1),
    product_interaction: z.string().nullable(),
    environment: z.string().min(1),
    on_screen_text: z.array(z.string()),
    notes: z.string().nullable(),
  })
  .strict();
export type ShotAnnotation = z.infer<typeof ShotAnnotation>;

/** `analysis/blueprint.json`: the whole reference, shot by shot, ready to adapt. */
export const Blueprint = z
  .object({
    source: z.object({ duration_sec: z.number().positive(), width: z.number().int(), height: z.number().int(), fps: z.number() }).strict(),
    transcript_path: z.string().nullable(),
    shots: z
      .array(
        z
          .object({
            shot_id: z.string(),
            start_sec: sec,
            end_sec: sec,
            /** The words spoken during the shot, from the transcript. */
            dialogue: z.string(),
            keyframes: z.array(z.string()),
            annotation: ShotAnnotation,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Blueprint = z.infer<typeof Blueprint>;

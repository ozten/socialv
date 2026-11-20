// Stage 1: what the reference video is, technically (`ffprobe`), and its
// audio track extracted as mono 16 kHz WAV for the transcriber.

import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { inside } from "../../step/files.ts";
import type { Probe } from "../../schemas/analysis.ts";
import type { ToolRole } from "../types.ts";
import { ffmpeg, ffprobe, sourcePath, tempBeside } from "./ffmpeg.ts";

/** Where the extracted audio goes, relative to the run folder. */
export const AUDIO_PATH = "analysis/audio.wav";

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_aspect_ratio?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number | string }[];
  disposition?: { attached_pic?: number };
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string };
}

export const probe: ToolRole = {
  name: "probe",
  kind: "tool",
  async run({ config, brief, runDir }) {
    const source = await sourcePath(config, brief.params.source);
    const { stdout } = await ffprobe(["-print_format", "json", "-show_format", "-show_streams", source]);
    const info = JSON.parse(stdout) as ProbeOutput;
    const streams = info.streams ?? [];
    // Cover art is a video stream too; skip it.
    const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
    if (!video?.width || !video.height) {
      throw new Error(`${brief.params.source} has no video stream`);
    }
    const audio = streams.find((s) => s.codec_type === "audio") ?? null;

    const duration = positive(info.format?.duration) ?? positive(video.duration);
    if (!duration) {
      throw new Error(`ffprobe reports no duration for ${brief.params.source}`);
    }
    const fps = rate(video.avg_frame_rate) ?? rate(video.r_frame_rate);
    if (!fps) {
      throw new Error(`ffprobe reports no frame rate for ${brief.params.source}`);
    }

    const rotation = rotationOf(video);
    // Display size: apply a non-square pixel aspect, then the rotation.
    const sar = rate(video.sample_aspect_ratio?.replace(":", "/")) ?? 1;
    let width = Math.round(video.width * sar);
    let height = video.height;
    if (rotation === 90 || rotation === 270) {
      [width, height] = [height, width];
    }

    let audioPath: string | null = null;
    if (audio) {
      const out = inside(runDir, AUDIO_PATH);
      await mkdir(path.dirname(out), { recursive: true });
      const temp = tempBeside(out);
      try {
        await ffmpeg(
          ["-y", "-i", source, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", temp],
          Math.max(60_000, duration * 5_000),
        );
        await rename(temp, out);
      } finally {
        await rm(temp, { force: true });
      }
      audioPath = AUDIO_PATH;
    }

    const value: Probe = {
      duration_sec: round(duration, 3),
      width,
      height,
      fps: round(fps, 3),
      rotation,
      orientation: width > height ? "landscape" : width < height ? "portrait" : "square",
      video_codec: video.codec_name ?? "unknown",
      audio: audio
        ? {
            codec: audio.codec_name ?? "unknown",
            sample_rate: Number(audio.sample_rate) || 1,
            channels: audio.channels || 1,
          }
        : null,
      audio_path: audioPath,
      size_bytes: Number(info.format?.size) || (await stat(source)).size,
    };
    const summary = `${value.width}x${value.height} ${value.orientation}, ${value.duration_sec} s at ${value.fps} fps, ${
      audio ? "audio extracted" : "no audio"
    }`;
    return { value, summary };
  },
};

/** Rotation in degrees, 0, 90, 180 or 270, from the display matrix or the legacy `rotate` tag. */
function rotationOf(stream: ProbeStream): number {
  const raw = stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0;
  const degrees = Math.round(Number(raw) / 90) * 90;
  return Number.isFinite(degrees) ? ((degrees % 360) + 360) % 360 : 0;
}

/** `30000/1001` or `30` as a number, or null for `0/0` and the like. */
function rate(text: string | undefined): number | null {
  if (!text) {
    return null;
  }
  const [num, den = "1"] = text.split("/");
  const value = Number(num) / Number(den);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function positive(text: string | undefined): number | null {
  const value = Number(text);
  return text !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

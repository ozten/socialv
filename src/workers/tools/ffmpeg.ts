// Shared plumbing for the tool roles that run ffmpeg and ffprobe: spawning
// with argument arrays (never a shell string), a timeout, and errors that
// carry the tail of ffmpeg's stderr.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../../config.ts";

/** How much of stderr an error carries. */
const STDERR_TAIL = 2000;

export interface Exec {
  stdout: string;
  stderr: string;
}

/**
 * Runs `cmd` with `args` and resolves with its output, or rejects with the
 * tail of its stderr when it exits non-zero, cannot start, or runs past
 * `timeoutMs` (it is killed then).
 */
export function exec(cmd: string, args: string[], timeoutMs: number): Promise<Exec> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      // Keep a bounded tail: a long encode can write a lot of stderr.
      err = (err + chunk.toString()).slice(-64_000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} could not start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString();
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s${tail(err)}`));
      } else if (code !== 0) {
        reject(new Error(`${cmd} failed (${signal ?? `exit ${code}`})${tail(err)}`));
      } else {
        resolve({ stdout, stderr: err });
      }
    });
  });
}

function tail(stderr: string): string {
  const text = stderr.trim();
  return text ? `:\n${text.slice(-STDERR_TAIL)}` : "";
}

export function ffmpeg(args: string[], timeoutMs: number): Promise<Exec> {
  return exec("ffmpeg", ["-hide_banner", "-nostdin", "-nostats", ...args], timeoutMs);
}

export function ffprobe(args: string[], timeoutMs = 30_000): Promise<Exec> {
  return exec("ffprobe", ["-v", "error", ...args], timeoutMs);
}

/**
 * The reference video named by `params.source`, a path relative to the
 * project folder. Refuses a path that escapes the project folder, and one
 * that is not a file.
 */
export async function sourcePath(config: Config, source: unknown): Promise<string> {
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error("params.source must be a path relative to the project folder, such as source/original.mov");
  }
  const root = path.resolve(config.projectDir);
  const full = path.resolve(root, source);
  const back = path.relative(root, full);
  if (back === "" || back.startsWith("..") || path.isAbsolute(back)) {
    throw new Error(`source ${JSON.stringify(source)} is not inside the project folder`);
  }
  let info;
  try {
    info = await stat(full);
  } catch {
    throw new Error(`source ${JSON.stringify(source)} does not exist in the project folder`);
  }
  if (!info.isFile()) {
    throw new Error(`source ${JSON.stringify(source)} is not a file`);
  }
  return full;
}

/** A number from params, or `fallback` when absent. Throws on a wrong type or range. */
export function numberParam(params: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const value = params[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`params.${name} must be a number from ${min} to ${max}, not ${JSON.stringify(value)}`);
  }
  return value;
}

/** A temporary sibling of `file`, for write-then-rename. Keeps the extension so ffmpeg picks the format. */
export function tempBeside(file: string): string {
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}.tmp-${process.pid}-${Date.now().toString(36)}${ext}`;
}

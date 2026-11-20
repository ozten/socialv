import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** `rel` resolved inside `dir`; throws if it would escape it. */
export function inside(dir: string, rel: string): string {
  const full = path.resolve(dir, rel);
  const back = path.relative(dir, full);
  if (back === "" || back.startsWith("..") || path.isAbsolute(back)) {
    throw new Error(`path ${JSON.stringify(rel)} is not inside the run folder`);
  }
  return full;
}

/** Writes a file by writing a temporary file beside it and renaming it. */
export async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temp, content);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

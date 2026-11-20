import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GatePage } from "./types.ts";

// Placeholder. The review module's owner replaces the body; the signature is fixed.

/** Writes the gate's review page into the run folder and returns its path relative to that folder. */
export async function writeGatePage(runDirPath: string, page: GatePage): Promise<string> {
  const relative = path.join("review", `${page.gate}.html`);
  const target = path.join(runDirPath, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `<!doctype html><title>${page.title}</title><pre>${JSON.stringify(page, null, 2).replace(/</g, "&lt;")}</pre>`);
  return relative;
}

import { mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { documentHtml, encodePath, escapeHtml, fileKind, formatBytes } from "./html.ts";
import type { GateItem, GatePage } from "./types.ts";

/** Text and JSON files up to this size are shown inline on the page. */
export const INLINE_LIMIT = 64 * 1024;

/**
 * Normalizes a path that should be relative to the run folder. Returns null
 * for anything absolute, anything that climbs out of the folder, or anything
 * odd enough not to be trusted in a link.
 */
export function safeRelativePath(file: string): string | null {
  if (!file || file.includes("\0") || file.includes("\\")) return null;
  if (file.startsWith("/") || /^[a-zA-Z]:/.test(file) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(file)) return null;
  const normal = path.posix.normalize(file);
  if (normal === "." || normal === ".." || normal.startsWith("../") || normal.startsWith("/")) return null;
  return normal.replace(/\/$/, "");
}

const GATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Writes the gate's review page into the run folder and returns its path relative to that folder. */
export async function writeGatePage(runDirPath: string, page: GatePage): Promise<string> {
  if (!GATE_NAME.test(page.gate)) {
    throw new Error(`gate id "${page.gate}" is not safe in a file name`);
  }
  const relative = path.posix.join("review", `${page.gate}.html`);
  const target = path.join(runDirPath, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const html = await renderGatePage(runDirPath, page);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, html);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return relative;
}

/** The gate page's HTML. File items are read from `runDirPath` to inline small text files. */
export async function renderGatePage(runDirPath: string, page: GatePage): Promise<string> {
  const items: string[] = [];
  for (const item of page.items) items.push(await renderItem(runDirPath, item));

  const body = `<header>
<p class="muted">Run <code>${escapeHtml(page.run)}</code> · gate <code>${escapeHtml(page.gate)}</code></p>
<h1>${escapeHtml(page.title)}</h1>
</header>
<div class="summary">${escapeHtml(page.summary)}</div>
${items.length ? items.join("\n") : `<p class="muted">This gate has no items.</p>`}
<section class="decide">
<h2>How to decide</h2>
${threadLink(page.threadUrl)}<p>Reply in the board thread <code>${escapeHtml(page.threadId)}</code> (channel <code>approvals/${escapeHtml(page.run)}</code>) with one of:</p>
<ul>
<li><code>approve</code> — everything above.</li>
<li><code>approve 1,3</code> — only those numbered items; the rest stay open.</li>
<li><code>revise: &lt;notes&gt;</code> — rework, with your notes.</li>
<li><code>reject: &lt;reason&gt;</code> — stop this branch.</li>
</ul>
<p class="muted">Only replies from the owner, posted after the packet, count.</p>
</section>`;
  return documentHtml(`${page.title} · ${page.gate}`, body);
}

/** A link to the gate's thread, only for an http(s) address. */
function threadLink(url: string | undefined): string {
  if (!url || !/^https?:\/\//.test(url)) return "";
  return `<p><a class="open-thread" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open this approval's thread on the board</a></p>\n`;
}

async function renderItem(runDirPath: string, item: GateItem): Promise<string> {
  const parts: string[] = [];
  parts.push(`<h2><span class="n">${escapeHtml(item.n)}</span>${escapeHtml(item.label)}</h2>`);
  if (item.meta && Object.keys(item.meta).length) {
    const facts = Object.entries(item.meta)
      .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
      .join("");
    parts.push(`<dl class="meta">${facts}</dl>`);
  }
  if (item.text) parts.push(`<div class="text">${escapeHtml(item.text)}</div>`);
  if (item.file !== undefined) parts.push(await renderFile(runDirPath, item.file));
  return `<section class="item" id="item-${escapeHtml(item.n)}">\n${parts.join("\n")}\n</section>`;
}

async function renderFile(runDirPath: string, file: string): Promise<string> {
  const relative = safeRelativePath(file);
  if (!relative) {
    return `<p class="file warn">File path refused (must be relative and inside the run folder): <code>${escapeHtml(file)}</code></p>`;
  }
  // The page lives in review/, one folder below the run folder.
  const href = escapeHtml(`../${encodePath(relative)}`);
  const name = `<p class="file"><a href="${href}">${escapeHtml(relative)}</a></p>`;
  switch (fileKind(relative)) {
    case "image":
      return `<img src="${href}" alt="${escapeHtml(relative)}" loading="lazy">\n${name}`;
    case "video":
      return `<video src="${href}" controls preload="metadata" playsinline></video>\n${name}`;
    case "audio":
      return `<audio src="${href}" controls preload="metadata"></audio>\n${name}`;
    case "json":
    case "text":
      return `${name}\n${await inlineText(runDirPath, relative)}`;
    default:
      return name;
  }
}

async function inlineText(runDirPath: string, relative: string): Promise<string> {
  let handle;
  try {
    const root = await realpath(runDirPath);
    const real = await realpath(path.join(runDirPath, relative));
    if (!real.startsWith(root + path.sep)) return `<p class="muted warn">Not shown: the file is outside the run folder.</p>`;
    handle = await open(real, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return "";
    if (stat.size > INLINE_LIMIT) return `<p class="muted">${formatBytes(stat.size)}; open the link to read it.</p>`;
    let text = (await handle.readFile()).toString("utf8");
    if (relative.toLowerCase().endsWith(".json")) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Show it as written.
      }
    }
    return `<pre>${escapeHtml(text)}</pre>`;
  } catch {
    return `<p class="muted warn">The file is missing.</p>`;
  } finally {
    await handle?.close();
  }
}

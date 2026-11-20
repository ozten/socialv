// The review server: a read-only static file server over the project's run
// folders, with plain listings. A stand-in for board attachments (design §11);
// it has no upload, no state and no application logic.

import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Config } from "../config.ts";
import { documentHtml, encodePath, escapeHtml, formatBytes } from "./html.ts";

export { writeGatePage } from "./page.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

export function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** No scripts, no outside requests; the page's own inline style and same-origin media only. */
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const MAX_TREE_ENTRIES = 2000;

export async function runReview(
  config: Config,
  opts: { port?: number; signal?: AbortSignal } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const port = opts.port ?? defaultPort(config.reviewUrl);
  const runsRoot = path.join(config.projectDir, "runs");
  const server = createServer((req, res) => {
    handle(runsRoot, req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, req, 500, "text/plain; charset=utf-8", "internal error\n");
      else res.destroy();
      process.stderr.write(`review: ${req.method} ${req.url}: ${String(error)}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  if (opts.signal) {
    if (opts.signal.aborted) await close();
    else opts.signal.addEventListener("abort", () => void close(), { once: true });
  }

  const { port: bound } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${bound}`, close };
}

function defaultPort(reviewUrl: string): number {
  const url = new URL(reviewUrl);
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

// ---------------------------------------------------------------- routing

async function handle(runsRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return send(res, req, 405, "text/plain; charset=utf-8", "method not allowed\n");
  }

  const segments = parsePath(req.url ?? "");
  if (!segments) return notFound(req, res);

  if (segments.length === 0) return listRuns(runsRoot, req, res);
  if (segments[0] !== "runs") return notFound(req, res);
  if (segments.length === 1) return redirect(res, "/");

  const rest = segments.slice(1);
  // `/runs/<run>/` arrives as ["runs", run, ""]; `/runs/<run>` as ["runs", run].
  if (rest.length === 1) return redirect(res, `/runs/${encodeURIComponent(rest[0]!)}/`);
  if (rest.length === 2 && rest[1] === "") return listRun(runsRoot, rest[0]!, req, res);
  if (rest.includes("")) return notFound(req, res);

  const real = await resolveInside(runsRoot, rest);
  if (!real) return notFound(req, res);
  const info = await stat(real);
  if (!info.isFile()) return notFound(req, res);
  return serveFile(real, info.size, info.mtime, req, res);
}

/**
 * Splits the raw request path into decoded segments. Returns null for
 * anything that could name a file outside the tree: dot segments (encoded or
 * not), separators or NUL hidden in a segment, or a path that is not absolute.
 * A trailing slash gives a final empty segment.
 */
export function parsePath(rawUrl: string): string[] | null {
  const raw = rawUrl.split(/[?#]/, 1)[0]!;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  const parts = raw.slice(1).split("/");
  if (parts.length === 1 && parts[0] === "") return [];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let segment: string;
    try {
      segment = decodeURIComponent(parts[i]!);
    } catch {
      return null;
    }
    if (segment === "" && i !== parts.length - 1) return null;
    if (segment === "." || segment === "..") return null;
    if (/[/\\\0]/.test(segment)) return null;
    out.push(segment);
  }
  return out;
}

/** Resolves segments under the runs folder, following symlinks, and refuses anything that lands outside it. */
async function resolveInside(runsRoot: string, segments: string[]): Promise<string | null> {
  const candidate = path.resolve(runsRoot, ...segments);
  if (!candidate.startsWith(runsRoot + path.sep)) return null;
  try {
    const [root, real] = await Promise.all([realpath(runsRoot), realpath(candidate)]);
    if (!real.startsWith(root + path.sep)) return null;
    return real;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- files

function commonHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

type Range = { start: number; end: number } | "unsatisfiable" | null;

/**
 * Parses a single `bytes=` range against a file size. Returns null when the
 * header is absent, malformed or asks for several ranges (the whole file is
 * then sent), and "unsatisfiable" when it cannot be met.
 */
export function parseRange(header: string | undefined, size: number): Range {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (last !== "" && Number(last) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

function serveFile(file: string, size: number, mtime: Date, req: IncomingMessage, res: ServerResponse): void {
  commonHeaders(res);
  res.setHeader("Content-Type", contentType(file));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Last-Modified", mtime.toUTCString());
  res.setHeader("Cache-Control", "no-cache");

  const range = parseRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.setHeader("Content-Range", `bytes */${size}`);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return void res.writeHead(416).end(req.method === "HEAD" ? undefined : "range not satisfiable\n");
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  res.setHeader("Content-Length", String(length));
  if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.writeHead(range ? 206 : 200);
  if (req.method === "HEAD" || length === 0) return void res.end();

  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function send(res: ServerResponse, req: IncomingMessage, status: number, type: string, body: string): void {
  commonHeaders(res);
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status);
  res.end(req.method === "HEAD" ? undefined : body);
}

function notFound(req: IncomingMessage, res: ServerResponse): void {
  send(res, req, 404, "text/plain; charset=utf-8", "not found\n");
}

function redirect(res: ServerResponse, location: string): void {
  commonHeaders(res);
  res.writeHead(301, { Location: location, "Content-Length": "0" }).end();
}

// ---------------------------------------------------------------- listings

async function listRuns(runsRoot: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let runs: Array<{ name: string; mtime: Date; gates: number }> = [];
  try {
    for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = path.join(runsRoot, entry.name);
      const gates = (await gatePages(dir)).length;
      runs.push({ name: entry.name, mtime: (await stat(dir)).mtime, gates });
    }
  } catch {
    // No runs folder yet.
  }
  runs = runs.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const rows = runs
    .map(
      (r) =>
        `<li><a href="/runs/${encodeURIComponent(r.name)}/">${escapeHtml(r.name)}</a>` +
        `<span class="size">${r.gates} gate page${r.gates === 1 ? "" : "s"} · ${escapeHtml(r.mtime.toISOString().slice(0, 16).replace("T", " "))}</span></li>`,
    )
    .join("\n");
  const body = `<h1>Runs</h1>
<p class="muted">${escapeHtml(runsRoot)}</p>
${runs.length ? `<ul class="files">\n${rows}\n</ul>` : `<p>No runs yet.</p>`}`;
  send(res, req, 200, "text/html; charset=utf-8", documentHtml("Runs · socialv review", body));
}

async function gatePages(runPath: string): Promise<string[]> {
  try {
    return (await readdir(path.join(runPath, "review"), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".html"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function listRun(runsRoot: string, run: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const runPath = await resolveInside(runsRoot, [run]);
  if (!runPath || !(await stat(runPath)).isDirectory()) return notFound(req, res);

  const base = `/runs/${encodeURIComponent(run)}/`;
  const gates = await gatePages(runPath);
  const gateList = gates.length
    ? `<ul class="files">\n${gates
        .map((g) => `<li><a href="${escapeHtml(base + "review/" + encodeURIComponent(g))}">${escapeHtml(g.replace(/\.html$/, ""))}</a></li>`)
        .join("\n")}\n</ul>`
    : `<p class="muted">No gate pages yet.</p>`;

  const files: Array<{ rel: string; size: number }> = [];
  await walk(runPath, "", files);
  const truncated = files.length >= MAX_TREE_ENTRIES;
  const fileList = files.length
    ? `<ul class="files">\n${files
        .map(
          (f) =>
            `<li><a href="${escapeHtml(base + encodePath(f.rel))}">${escapeHtml(f.rel)}</a><span class="size">${formatBytes(f.size)}</span></li>`,
        )
        .join("\n")}\n</ul>${truncated ? `<p class="muted">Only the first ${MAX_TREE_ENTRIES} files are listed.</p>` : ""}`
    : `<p class="muted">The run folder is empty.</p>`;

  const body = `<p class="muted"><a href="/">Runs</a></p>
<h1>Run ${escapeHtml(run)}</h1>
<h2>Gate pages</h2>
${gateList}
<h2 style="margin-top:1.5rem">Files</h2>
${fileList}`;
  send(res, req, 200, "text/html; charset=utf-8", documentHtml(`${run} · socialv review`, body));
}

/** Collects regular files under `dir`, sorted, without following symlinks to directories. */
async function walk(root: string, rel: string, out: Array<{ rel: string; size: number }>): Promise<void> {
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_TREE_ENTRIES) return;
    if (entry.name.startsWith(".")) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(root, child, out);
    else if (entry.isFile()) out.push({ rel: child, size: (await lstat(path.join(root, child))).size });
  }
}

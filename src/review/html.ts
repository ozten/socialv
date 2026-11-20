// Small HTML helpers shared by gate pages and the review server's listings.
// Everything here is plain strings: no templates, no framework.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for use in element content and in quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Encodes a relative path for an href or src, one segment at a time. */
export function encodePath(relative: string): string {
  return relative.split("/").map(encodeURIComponent).join("/");
}

/** A human file size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Media kinds the review pages show inline, by file extension. */
export type FileKind = "image" | "video" | "audio" | "json" | "text" | "html" | "other";

const KINDS: Record<string, FileKind> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".wav": "audio",
  ".mp3": "audio",
  ".m4a": "audio",
  ".json": "json",
  ".txt": "text",
  ".md": "text",
  ".html": "html",
};

export function fileKind(file: string): FileKind {
  const dot = file.lastIndexOf(".");
  if (dot < 0 || dot < file.lastIndexOf("/")) return "other";
  return KINDS[file.slice(dot).toLowerCase()] ?? "other";
}

/** The stylesheet every page carries inline. Light and dark, readable at phone width. */
export const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #5f6368; --bg: #ffffff; --panel: #f5f5f7;
  --line: #d9d9de; --accent: #0b57d0; --code: #eef0f3; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e8e8ea; --muted: #a0a4ab; --bg: #141416; --panel: #1e1f22; --line: #34363b;
    --accent: #8ab4f8; --code: #26282c; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 .25rem; overflow-wrap: anywhere; }
h2 { font-size: 1.1rem; margin: 0 0 .5rem; overflow-wrap: anywhere; }
a { color: var(--accent); }
p { margin: .5rem 0; }
.muted { color: var(--muted); font-size: .9rem; }
.summary { white-space: pre-wrap; overflow-wrap: anywhere; margin: 1rem 0 1.5rem; }
.item { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 1rem; margin: 0 0 1rem; }
.n { display: inline-block; min-width: 1.9rem; padding: 0 .45rem; margin-right: .4rem; border-radius: 999px;
  background: var(--fg); color: var(--bg); text-align: center; font-size: .95rem; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
dl.meta { display: flex; flex-wrap: wrap; gap: .25rem 1rem; margin: .5rem 0; font-size: .85rem; color: var(--muted); }
dl.meta div { display: flex; gap: .3rem; min-width: 0; }
dl.meta dt { font-weight: 600; }
dl.meta dd { margin: 0; overflow-wrap: anywhere; }
img, video { display: block; max-width: 100%; height: auto; max-height: 80vh; margin: .5rem 0;
  border-radius: 6px; background: #000; }
audio { width: 100%; margin: .5rem 0; }
pre { background: var(--code); padding: .75rem; border-radius: 6px; overflow-x: auto;
  font: .85rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code);
  padding: .05rem .3rem; border-radius: 4px; overflow-wrap: anywhere; }
.file { font-size: .85rem; overflow-wrap: anywhere; }
.decide { border-top: 1px solid var(--line); margin-top: 2rem; padding-top: 1rem; }
.decide ul { padding-left: 1.2rem; }
.decide li { margin: .3rem 0; }
ul.files { list-style: none; padding: 0; margin: 0; font-size: .9rem; }
ul.files li { padding: .15rem 0; overflow-wrap: anywhere; }
ul.files .size { color: var(--muted); margin-left: .5rem; }
.warn { color: #b3261e; }
@media (prefers-color-scheme: dark) { .warn { color: #f2b8b5; } }
`;

/** A complete HTML document with the shared inline style. `body` must already be escaped. */
export function documentHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

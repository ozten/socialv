import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INLINE_LIMIT, renderGatePage, safeRelativePath, writeGatePage } from "../../src/review/page.ts";
import type { GatePage } from "../../src/review/types.ts";

const HOSTILE = `<script>alert("x")</script>'"&`;

let root: string;
let runDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "socialv-page-"));
  runDir = path.join(root, "runs", "r1");
  await mkdir(runDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function page(overrides: Partial<GatePage> = {}): GatePage {
  return {
    run: "r1",
    gate: "review-1",
    title: "Blueprint review",
    summary: "Three shots.",
    items: [],
    threadId: "m_123",
    ...overrides,
  };
}

describe("writeGatePage", () => {
  it("writes review/<gate>.html and returns the relative path, atomically", async () => {
    const rel = await writeGatePage(runDir, page());
    expect(rel).toBe("review/review-1.html");
    const html = await readFile(path.join(runDir, rel), "utf8");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("Blueprint review");
    expect(await readdir(path.join(runDir, "review"))).toEqual(["review-1.html"]);
  });

  it("refuses a gate id that is not safe in a file name", async () => {
    await expect(writeGatePage(runDir, page({ gate: "../evil" }))).rejects.toThrow(/not safe/);
    await expect(writeGatePage(runDir, page({ gate: "a/b" }))).rejects.toThrow(/not safe/);
  });

  it("has no scripts and no external requests", async () => {
    const html = await renderGatePage(runDir, page({ items: [{ n: 1, label: "a", file: "x.png" }] }));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//i);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('name="viewport"');
  });
});

describe("escaping", () => {
  it("escapes hostile strings in every field", async () => {
    await writeFile(path.join(runDir, "notes.txt"), HOSTILE);
    const html = await renderGatePage(runDir, {
      run: HOSTILE,
      gate: "g1",
      title: HOSTILE,
      summary: HOSTILE,
      threadId: HOSTILE,
      items: [
        { n: 1, label: HOSTILE, text: HOSTILE, meta: { [HOSTILE]: HOSTILE } },
        { n: 2, label: "file", file: "notes.txt" },
        { n: 3, label: "odd name", file: `a"><script>x.png` },
      ],
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain(`"x")`);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&quot;&amp;");
    // The file name is URL-encoded inside the attribute, so it cannot close it.
    expect(html).toContain(`src="../a%22%3E%3Cscript%3Ex.png"`);
  });
});

describe("file items", () => {
  async function render(file: string): Promise<string> {
    return renderGatePage(runDir, page({ items: [{ n: 1, label: "it", file }] }));
  }

  it("renders images, video and audio with the right element, relative to the page", async () => {
    expect(await render("renders/a b.png")).toContain(`<img src="../renders/a%20b.png"`);
    expect(await render("shot.JPG")).toContain(`<img src="../shot.JPG"`);
    expect(await render("take.webp")).toContain("<img ");
    expect(await render("renders/take.mp4")).toMatch(/<video src="\.\.\/renders\/take\.mp4" controls/);
    expect(await render("t.mov")).toContain("<video ");
    expect(await render("t.webm")).toContain("<video ");
    expect(await render("vo.wav")).toMatch(/<audio src="\.\.\/vo\.wav" controls/);
    expect(await render("vo.mp3")).toContain("<audio ");
    expect(await render("vo.m4a")).toContain("<audio ");
  });

  it("links anything else", async () => {
    const html = await render("final/package.zip");
    expect(html).toContain(`<a href="../final/package.zip">`);
    expect(html).not.toMatch(/<(img|video|audio) /);
  });

  it("inlines small JSON, text and markdown, escaped", async () => {
    await writeFile(path.join(runDir, "a.json"), `{"k":"<b>"}`);
    await writeFile(path.join(runDir, "b.md"), "# <i>hi</i>");
    expect(await render("a.json")).toContain(`<pre>{\n  &quot;k&quot;: &quot;&lt;b&gt;&quot;\n}</pre>`);
    expect(await render("b.md")).toContain("<pre># &lt;i&gt;hi&lt;/i&gt;</pre>");
  });

  it("links a large text file instead of inlining it", async () => {
    await writeFile(path.join(runDir, "big.txt"), "x".repeat(INLINE_LIMIT + 1));
    const html = await render("big.txt");
    expect(html).not.toContain("<pre>");
    expect(html).toContain(`href="../big.txt"`);
  });

  it("says when a text file is missing", async () => {
    expect(await render("nope.txt")).toContain("missing");
  });

  it("refuses paths outside the run folder", async () => {
    for (const bad of ["../other/x.png", "/etc/passwd", "a/../../x.txt", "C:\\x.png", "https://evil.example/x.png", "..", ""]) {
      const html = await render(bad);
      expect(html, bad).toContain("File path refused");
      expect(html, bad).not.toMatch(/<(img|video|audio) /);
    }
  });

  it("does not inline a text file through a symlink that leaves the run folder", async () => {
    await writeFile(path.join(root, "secret.txt"), "SECRET");
    await symlink(path.join(root, "secret.txt"), path.join(runDir, "link.txt"));
    const html = await render("link.txt");
    expect(html).not.toContain("SECRET");
  });
});

describe("decision instructions", () => {
  it("shows the thread and the four reply forms", async () => {
    const html = await renderGatePage(runDir, page({ threadId: "m_42" }));
    expect(html).toContain("<code>m_42</code>");
    for (const form of ["approve", "approve 1,3", "revise: &lt;notes&gt;", "reject: &lt;reason&gt;"]) {
      expect(html).toContain(`<code>${form}</code>`);
    }
  });
});

describe("safeRelativePath", () => {
  it("normalizes good paths and refuses bad ones", () => {
    expect(safeRelativePath("a/./b.png")).toBe("a/b.png");
    expect(safeRelativePath("a/x/../b.png")).toBe("a/b.png");
    expect(safeRelativePath("../a")).toBeNull();
    expect(safeRelativePath("/a")).toBeNull();
    expect(safeRelativePath("a\0b")).toBeNull();
    expect(safeRelativePath("javascript:alert(1)")).toBeNull();
  });
});

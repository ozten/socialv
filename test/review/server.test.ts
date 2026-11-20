import { request } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.ts";
import { parsePath, parseRange, runReview } from "../../src/review/index.ts";
import { writeGatePage } from "../../src/review/page.ts";

let root: string;
let server: { url: string; close(): Promise<void> };
const BYTES = Buffer.from("0123456789abcdefghij"); // 20 bytes

/** A raw request, so the path reaches the server exactly as written. */
function get(
  rawPath: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const { port } = new URL(server.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: rawPath, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "socialv-review-"));
  const projectDir = path.join(root, "project");
  const run = path.join(projectDir, "runs", "r1");
  await mkdir(path.join(run, "renders"), { recursive: true });
  await writeFile(path.join(run, "renders", "take.mp4"), BYTES);
  await writeFile(path.join(run, "still.png"), BYTES);
  await writeFile(path.join(run, "a.json"), "{}");
  await writeFile(path.join(run, "notes.md"), "# hi");
  await writeFile(path.join(run, "vo.m4a"), BYTES);
  await writeFile(path.join(run, "page.html"), "<p>x</p>");
  await writeFile(path.join(run, "blob.bin"), BYTES);
  await writeFile(path.join(run, "empty.txt"), "");
  await writeFile(path.join(root, "secret.txt"), "SECRET");
  await writeFile(path.join(projectDir, "project.json"), "PROJECT");
  await symlink(path.join(root, "secret.txt"), path.join(run, "escape.txt"));
  await symlink(root, path.join(run, "escape-dir"));
  await symlink(path.join(run, "a.json"), path.join(run, "inside-link.json"));
  await mkdir(path.join(projectDir, "runs", `<b>evil"&`));
  await writeGatePage(run, { run: "r1", gate: "review-1", title: "T", summary: "S", items: [], threadId: "m_1" });

  const config: Config = {
    boardUrl: "http://127.0.0.1:1",
    boardName: "test",
    principal: "local",
    owner: "local",
    projectDir,
    reviewUrl: "http://127.0.0.1:1",
    runtime: "fake",
  };
  server = await runReview(config, { port: 0 });
});

afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

describe("serving files", () => {
  it("binds to loopback", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it.each([
    ["renders/take.mp4", "video/mp4"],
    ["still.png", "image/png"],
    ["a.json", "application/json; charset=utf-8"],
    ["notes.md", "text/plain; charset=utf-8"],
    ["vo.m4a", "audio/mp4"],
    ["page.html", "text/html; charset=utf-8"],
    ["blob.bin", "application/octet-stream"],
    ["review/review-1.html", "text/html; charset=utf-8"],
  ])("serves %s as %s", async (file, type) => {
    const res = await get(`/runs/r1/${file}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe(type);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["accept-ranges"]).toBe("bytes");
  });

  it("serves the whole body with its length", async () => {
    const res = await get("/runs/r1/renders/take.mp4");
    expect(res.body.equals(BYTES)).toBe(true);
    expect(res.headers["content-length"]).toBe("20");
  });

  it("serves an empty file", async () => {
    const res = await get("/runs/r1/empty.txt");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });

  it("follows a symlink that stays inside the runs folder", async () => {
    expect((await get("/runs/r1/inside-link.json")).status).toBe(200);
  });

  it("answers HEAD with headers and no body", async () => {
    const res = await get("/runs/r1/renders/take.mp4", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe("20");
    expect(res.body.length).toBe(0);
  });

  it("404s a missing file and a directory", async () => {
    expect((await get("/runs/r1/nope.mp4")).status).toBe(404);
    expect((await get("/runs/r1/renders")).status).toBe(404);
    expect((await get("/runs/nope/")).status).toBe(404);
    expect((await get("/elsewhere")).status).toBe(404);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("refuses %s with 405", async (method) => {
    const res = await get("/runs/r1/a.json", { method });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, HEAD");
  });
});

describe("ranges", () => {
  const video = "/runs/r1/renders/take.mp4";

  it("serves a byte range with 206", async () => {
    const res = await get(video, { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 2-5/20");
    expect(res.headers["content-length"]).toBe("4");
    expect(res.body.toString()).toBe("2345");
  });

  it("serves an open-ended range", async () => {
    const res = await get(video, { headers: { Range: "bytes=15-" } });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 15-19/20");
    expect(res.body.toString()).toBe("fghij");
  });

  it("serves a suffix range", async () => {
    const res = await get(video, { headers: { Range: "bytes=-3" } });
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 17-19/20");
    expect(res.body.toString()).toBe("hij");
  });

  it("clamps an end past the file", async () => {
    const res = await get(video, { headers: { Range: "bytes=18-100" } });
    expect(res.headers["content-range"]).toBe("bytes 18-19/20");
    expect(res.body.toString()).toBe("ij");
  });

  it("answers an unsatisfiable range with 416", async () => {
    const res = await get(video, { headers: { Range: "bytes=20-30" } });
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */20");
  });

  it("answers HEAD with a range", async () => {
    const res = await get(video, { method: "HEAD", headers: { Range: "bytes=0-0" } });
    expect(res.status).toBe(206);
    expect(res.headers["content-length"]).toBe("1");
    expect(res.body.length).toBe(0);
  });

  it("ignores a malformed range", async () => {
    const res = await get(video, { headers: { Range: "lines=1-2" } });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(20);
  });

  it("parses ranges", () => {
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=-20", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 10)).toBeNull();
    expect(parseRange("bytes=0-1,3-4", 10)).toBeNull();
    expect(parseRange(undefined, 10)).toBeNull();
  });
});

describe("traversal", () => {
  it.each([
    "/runs/r1/../../project.json",
    "/runs/../project.json",
    "/runs/r1/%2e%2e/%2e%2e/project.json",
    "/runs/r1/%2E%2E/%2E%2E/project.json",
    "/runs/r1/..%2f..%2fproject.json",
    "/runs/r1/..%5c..%5cproject.json",
    "/runs/%2e%2e/project.json",
    "/runs/r1/%2fetc%2fpasswd",
    "//etc/passwd",
    "/runs/r1//etc/passwd",
    "/runs/r1/a.json%00.png",
    "/runs/r1/%E0%A4%A",
    "/runs/r1/escape.txt",
    "/runs/r1/escape-dir/secret.txt",
  ])("refuses %s", async (raw) => {
    const res = await get(raw);
    expect(res.status).toBe(404);
    expect(res.body.toString()).not.toContain("SECRET");
    expect(res.body.toString()).not.toContain("PROJECT");
  });

  it("refuses an absolute-form request target outside the tree", async () => {
    const res = await get("http://127.0.0.1/etc/passwd");
    expect(res.status).toBe(404);
  });

  it("parses paths into segments", () => {
    expect(parsePath("/")).toEqual([]);
    expect(parsePath("/runs/r1/")).toEqual(["runs", "r1", ""]);
    expect(parsePath("/runs/a%20b/c.png?x=1")).toEqual(["runs", "a b", "c.png"]);
    expect(parsePath("/runs/./x")).toBeNull();
  });
});

describe("listings", () => {
  it("lists runs at /, escaped", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    const html = res.body.toString();
    expect(html).toContain(`href="/runs/r1/"`);
    expect(html).toContain("&lt;b&gt;evil&quot;&amp;");
    expect(html).not.toContain("<b>evil");
  });

  it("lists a run's gate pages, then its files", async () => {
    const res = await get("/runs/r1/");
    expect(res.status).toBe(200);
    const html = res.body.toString();
    const gate = html.indexOf(`href="/runs/r1/review/review-1.html"`);
    const file = html.indexOf(`href="/runs/r1/renders/take.mp4"`);
    expect(gate).toBeGreaterThan(0);
    expect(file).toBeGreaterThan(gate);
    expect(html).not.toContain("SECRET");
  });

  it("redirects /runs/<run> to the listing", async () => {
    const res = await get("/runs/r1");
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("/runs/r1/");
  });
});

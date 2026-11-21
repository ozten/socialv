// The project view (design 6.2): everything a run's analysis produced, scene
// by scene, with the controls to accept a scene or ask for a fix. Decisions
// are posted to the board by the server, in the gate's thread; this module
// only reads files and renders.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { runDir, type Config } from "../config.ts";
import { Blueprint, Probe, Transcript } from "../schemas/analysis.ts";
import { encodePath, escapeHtml, STYLE } from "./html.ts";

export interface ProjectData {
  run: string;
  /** Path of the reference video under the project folder, when the run names one. */
  source: string | null;
  probe: Probe | null;
  transcript: Transcript | null;
  blueprint: Blueprint | null;
  /** Dollars the gateway recorded for this run. */
  paidUsd: number;
  /** Dollars of model usage the agent sessions reported. */
  agentUsd: number;
}

async function json(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function parsed<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export async function loadProject(config: Config, run: string): Promise<ProjectData> {
  const dir = runDir(config, run);
  const settings = (await json(path.join(dir, "run.json"))) as { params?: { source?: unknown } } | null;
  const source = typeof settings?.params?.source === "string" ? settings.params.source : null;

  let paidUsd = 0;
  try {
    const rows = (await readFile(path.join(dir, "manifests", "cost_log.csv"), "utf8")).trim().split("\n");
    const header = rows[0]!.split(",");
    const event = header.indexOf("event");
    const actual = header.indexOf("actual_usd");
    for (const row of rows.slice(1)) {
      const cells = row.split(",");
      if (cells[event] === "succeeded") paidUsd += Number(cells[actual]) || 0;
    }
  } catch {
    // No paid calls yet.
  }

  let agentUsd = 0;
  try {
    for (const line of (await readFile(path.join(dir, "sessions", "usage.jsonl"), "utf8")).split("\n")) {
      if (line.trim()) agentUsd += Number((JSON.parse(line) as { usage?: { costUsd?: number } }).usage?.costUsd) || 0;
    }
  } catch {
    // No agent sessions yet.
  }

  return {
    run,
    source,
    probe: parsed(Probe, await json(path.join(dir, "analysis", "probe.json"))),
    transcript: parsed(Transcript, await json(path.join(dir, "analysis", "transcript.json"))),
    blueprint: parsed(Blueprint, await json(path.join(dir, "analysis", "blueprint.json"))),
    paidUsd,
    agentUsd,
  };
}

const PAGE_STYLE = `
main { max-width: 72rem; }
.top { display: grid; grid-template-columns: minmax(0, 15rem) minmax(0, 1fr); gap: 1.25rem; align-items: start; margin: 1rem 0 1.5rem; }
.top video { margin: 0; width: 100%; }
.facts { display: flex; flex-wrap: wrap; gap: .25rem 1.25rem; font-size: .9rem; color: var(--muted); margin: .25rem 0 .75rem; }
.transcript { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 14rem; overflow-y: auto; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px; padding: .75rem; font-size: .95rem; }
.banner { border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; padding: .6rem .9rem; margin: 1rem 0; background: var(--panel); }
.banner.done { border-left-color: #1e8e3e; }
.banner.stop { border-left-color: #b3261e; }
.scene { display: grid; grid-template-columns: minmax(0, 14rem) minmax(0, 1fr); gap: 1rem; background: var(--panel);
  border: 1px solid var(--line); border-left: 5px solid var(--line); border-radius: 10px; padding: 1rem; margin: 0 0 1rem; scroll-margin-top: 1rem; }
.scene[data-choice="ok"] { border-left-color: #1e8e3e; }
.scene[data-choice="fix"] { border-left-color: #e37400; }
.scene video { margin: 0; width: 100%; cursor: pointer; }
.frames { display: flex; gap: .3rem; margin-top: .4rem; }
.frames a { flex: 1 1 0; min-width: 0; }
.frames img { margin: 0; width: 100%; border-radius: 4px; }
.scene h2 { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem; }
.scene h2 .time { color: var(--muted); font-weight: 400; font-size: .9rem; }
.purpose { font-weight: 600; margin: 0 0 .4rem; }
.scene ol { margin: .25rem 0 .5rem; padding-left: 1.3rem; }
.scene dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .15rem .75rem; margin: .5rem 0; font-size: .92rem; }
.scene dt { color: var(--muted); }
.scene dd { margin: 0; overflow-wrap: anywhere; }
.quote { font-style: italic; }
details.more { font-size: .9rem; color: var(--muted); margin: .25rem 0; }
.choose { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
button { font: inherit; padding: .4rem .9rem; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600; }
button.danger { color: #b3261e; }
.scene[data-choice="ok"] button.ok { background: #1e8e3e; border-color: #1e8e3e; color: #fff; }
.scene[data-choice="fix"] button.fix { background: #e37400; border-color: #e37400; color: #fff; }
textarea { font: inherit; width: 100%; min-height: 4rem; margin-top: .5rem; padding: .5rem; border-radius: 8px;
  border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
.scene textarea { display: none; }
.scene[data-choice="fix"] textarea { display: block; }
.bar { position: sticky; bottom: 0; background: var(--bg); border-top: 1px solid var(--line); padding: .75rem 0; margin-top: 1.5rem;
  display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; }
.bar .count { flex: 1 1 14rem; font-size: .95rem; }
#reject-box { display: none; width: 100%; }
#reject-box.open { display: block; }
#message { width: 100%; font-size: .95rem; }
@media (max-width: 40rem) { .top, .scene { grid-template-columns: minmax(0, 1fr); } }
`;

const fmt = (sec: number) => `${sec.toFixed(1)} s`;

function dd(term: string, value: string | null | undefined, cls = ""): string {
  return value ? `<dt>${escapeHtml(term)}</dt><dd${cls ? ` class="${cls}"` : ""}>${escapeHtml(value)}</dd>` : "";
}

/** The whole page. Everything that came from a file or a model is escaped. */
export function projectHtml(data: ProjectData): string {
  const base = `/runs/${encodeURIComponent(data.run)}/`;
  const video = data.source ? `/project/${encodePath(data.source)}` : null;
  const shots = data.blueprint?.shots ?? [];

  const facts = [
    data.probe ? `${data.probe.width}×${data.probe.height} ${data.probe.orientation}` : null,
    data.probe ? fmt(data.probe.duration_sec) : null,
    shots.length ? `${shots.length} scenes` : null,
    data.transcript ? `${data.transcript.words.length} words spoken` : null,
    `spent $${data.paidUsd.toFixed(2)} on providers, $${data.agentUsd.toFixed(2)} of agent usage`,
  ].filter(Boolean);

  const scenes = shots
    .map((shot, index) => {
      const a = shot.annotation;
      const n = String(index + 1).padStart(2, "0");
      const poster = shot.keyframes[0] ? `${base}${encodePath(shot.keyframes[0])}` : "";
      const clip = video
        ? `<video preload="none" playsinline muted loop data-start="${shot.start_sec}" data-end="${shot.end_sec}"${poster ? ` poster="${escapeHtml(poster)}"` : ""} src="${escapeHtml(video)}#t=${shot.start_sec},${shot.end_sec}" title="Play this scene"></video>`
        : poster
          ? `<img src="${escapeHtml(poster)}" alt="">`
          : "";
      const frames = shot.keyframes
        .map((k) => `<a href="${escapeHtml(base + encodePath(k))}" target="_blank" rel="noopener"><img loading="lazy" src="${escapeHtml(base + encodePath(k))}" alt="frame"></a>`)
        .join("");
      return `<section class="scene" id="${escapeHtml(shot.shot_id)}" data-shot="${escapeHtml(shot.shot_id)}">
<div>
${clip}
<div class="frames">${frames}</div>
</div>
<div>
<h2>Scene ${n} <span class="time">${fmt(shot.start_sec)} to ${fmt(shot.end_sec)} · ${fmt(shot.end_sec - shot.start_sec)}</span></h2>
<p class="purpose">${escapeHtml(a.purpose)}</p>
<ol>${a.action_beats.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ol>
<dl>
${dd("Spoken", shot.dialogue.trim() ? `“${shot.dialogue.trim()}”` : "nothing", "quote")}
${dd("On screen", a.on_screen_text.length ? a.on_screen_text.map((t) => `“${t}”`).join(", ") : "nothing")}
${dd("Framing", a.framing)}
${dd("Camera", a.camera_motion)}
${dd("Who and what", a.subjects.join("; "))}
${dd("Product", a.product_interaction)}
${dd("Setting", a.environment)}
</dl>
${a.notes ? `<details class="more"><summary>Analyst's notes</summary><p>${escapeHtml(a.notes)}</p></details>` : ""}
<div class="choose">
<button type="button" class="ok">Looks right</button>
<button type="button" class="fix">Needs a fix</button>
</div>
<textarea placeholder="What is wrong with this description? The scene is described again with your note." aria-label="What to fix in scene ${n}"></textarea>
</div>
</section>`;
    })
    .join("\n");

  const body = `<p class="muted"><a href="/">Projects</a> · <a href="${base}?files">all files</a></p>
<h1>${escapeHtml(data.run)}</h1>
<div class="facts">${facts.map((f) => `<span>${escapeHtml(f!)}</span>`).join("")}</div>
<div id="status" class="banner">Checking where this stands…</div>
<div class="top">
<div>${video ? `<video controls playsinline preload="metadata" src="${escapeHtml(video)}"></video>` : `<p class="muted">No reference video recorded for this run.</p>`}</div>
<div>
<h2>What is said</h2>
<div class="transcript">${data.transcript ? escapeHtml(data.transcript.text || "(no speech)") : `<span class="muted">No transcript yet.</span>`}</div>
<p class="muted">Below is what the analysis says each scene of the reference shows. Check each against its clip. Mark it right, or say what to fix; only the scenes you flag are described again. Direction for the new video belongs to the script, which comes next.</p>
</div>
</div>
${shots.length ? scenes : `<p class="muted">The analysis has not finished yet. This page fills in when it has.</p>`}
<div class="bar" id="bar" hidden>
<div class="count" id="count"></div>
<button type="button" id="all-ok">Mark the rest as right</button>
<button type="button" class="primary" id="send" disabled>Send</button>
<button type="button" class="danger" id="reject">Reject…</button>
<div id="reject-box">
<textarea id="reject-reason" placeholder="Why reject the whole analysis? This stops the run." aria-label="Reason for rejecting"></textarea>
<div class="choose"><button type="button" class="danger" id="reject-send">Reject and stop the run</button><button type="button" id="reject-cancel">Cancel</button></div>
</div>
<div id="message" role="status"></div>
</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(data.run)} · socialv</title>
<style>${STYLE}${PAGE_STYLE}</style>
</head>
<body data-run="${escapeHtml(data.run)}">
<main>
${body}
</main>
<script src="/app/project.js"></script>
</body>
</html>
`;
}

/** The page's script. Plain JavaScript, served as a file so the policy needs no inline scripts. */
export const PROJECT_JS = String.raw`"use strict";
(() => {
  const run = document.body.dataset.run;
  const api = "/api/runs/" + encodeURIComponent(run);
  const scenes = [...document.querySelectorAll(".scene")];
  const $ = (id) => document.getElementById(id);
  const status = $("status"), bar = $("bar"), count = $("count"), send = $("send"), message = $("message");
  let gate = null;       // { id, rev } when a decision is wanted
  let busy = false;

  // Choices survive a reload, per revision. Storage can be unavailable: the page works without it.
  const key = () => "socialv:" + run + ":r" + (gate ? gate.rev : 0);
  const load = () => { try { return JSON.parse(localStorage.getItem(key()) || "{}"); } catch { return {}; } };
  const save = () => {
    const out = {};
    for (const s of scenes) if (s.dataset.choice) out[s.dataset.shot] = { c: s.dataset.choice, n: s.querySelector("textarea").value };
    try { localStorage.setItem(key(), JSON.stringify(out)); } catch {}
  };

  function refresh() {
    const ok = scenes.filter((s) => s.dataset.choice === "ok").length;
    const fix = scenes.filter((s) => s.dataset.choice === "fix");
    const left = scenes.length - ok - fix.length;
    const missing = fix.filter((s) => !s.querySelector("textarea").value.trim()).length;
    count.textContent = ok + " right, " + fix.length + " to fix, " + left + " not looked at";
    send.textContent = fix.length ? "Send " + fix.length + " back for a fix" : "Approve the analysis";
    send.disabled = busy || !gate || left > 0 || missing > 0;
    $("all-ok").disabled = busy || left === 0;
    message.textContent = missing ? "Say what to fix in each flagged scene." : "";
  }

  function choose(scene, choice) {
    scene.dataset.choice = scene.dataset.choice === choice ? "" : choice;
    if (scene.dataset.choice === "fix") scene.querySelector("textarea").focus();
    save(); refresh();
  }

  for (const s of scenes) {
    s.querySelector(".ok").addEventListener("click", () => choose(s, "ok"));
    s.querySelector(".fix").addEventListener("click", () => choose(s, "fix"));
    s.querySelector("textarea").addEventListener("input", () => { save(); refresh(); });
    const v = s.querySelector("video");
    if (v) {
      const start = Number(v.dataset.start), end = Number(v.dataset.end);
      v.addEventListener("click", () => { if (v.paused) { if (v.currentTime < start || v.currentTime >= end) v.currentTime = start; v.play(); } else v.pause(); });
      v.addEventListener("timeupdate", () => { if (v.currentTime >= end || v.currentTime < start - 0.3) v.currentTime = start; });
    }
  }
  $("all-ok").addEventListener("click", () => { for (const s of scenes) if (!s.dataset.choice) s.dataset.choice = "ok"; save(); refresh(); });
  $("reject").addEventListener("click", () => $("reject-box").classList.add("open"));
  $("reject-cancel").addEventListener("click", () => $("reject-box").classList.remove("open"));

  async function post(body) {
    busy = true; refresh(); message.textContent = "Sending…";
    try {
      const res = await fetch(api + "/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ gate: gate.id, ...body }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || ("the server answered " + res.status));
      try { localStorage.removeItem(key()); } catch {}
      gate = null; bar.hidden = true;
      show("Sent: " + out.summary + " It is recorded on the board.", "");
      setTimeout(poll, 1500);
    } catch (error) {
      message.textContent = "Not sent: " + error.message;
    } finally { busy = false; refresh(); }
  }

  send.addEventListener("click", () => {
    const shots = {};
    for (const s of scenes) if (s.dataset.choice === "fix") shots[s.dataset.shot] = s.querySelector("textarea").value.trim();
    post(Object.keys(shots).length ? { kind: "revise", shots } : { kind: "approve" });
  });
  $("reject-send").addEventListener("click", () => {
    const reason = $("reject-reason").value.trim();
    if (!reason) { message.textContent = "Say why."; return; }
    post({ kind: "reject", reason });
  });

  function show(text, cls, link) {
    status.className = "banner" + (cls ? " " + cls : "");
    status.textContent = text;
    if (link) { const a = document.createElement("a"); a.href = link; a.textContent = "Open the thread on the board"; a.target = "_blank"; a.rel = "noopener"; status.append(" ", a); }
  }

  let lastRev = null;
  async function poll() {
    try {
      const s = await (await fetch(api, { headers: { Accept: "application/json" } })).json();
      if (s.state === "waiting") {
        if (lastRev !== null && s.gate.rev !== lastRev) { location.reload(); return; }
        lastRev = s.gate.rev;
        if (!gate) {
          gate = s.gate;
          const saved = load();
          for (const sc of scenes) { const c = saved[sc.dataset.shot]; if (c) { sc.dataset.choice = c.c; sc.querySelector("textarea").value = c.n || ""; } }
          bar.hidden = false; refresh();
        }
        show("Waiting for your review" + (s.gate.rev > 1 ? " (revision " + s.gate.rev + ")" : "") + ".", "", s.gate.link);
      } else {
        gate = null; bar.hidden = true;
        if (s.state === "approved") show("You approved this analysis.", "done", s.gate && s.gate.link);
        else if (s.state === "rejected") show("You rejected this analysis. The run has stopped.", "stop", s.gate && s.gate.link);
        else if (s.state === "reworking") { show("Scenes you flagged are being described again. This page reloads when they are ready.", ""); lastRev = lastRev ?? -1; }
        else show(s.state === "unknown" ? "Cannot reach the board: " + (s.error || "") : "The analysis is still running.", s.state === "unknown" ? "stop" : "");
      }
    } catch (error) {
      show("Cannot reach the socialv server: " + error.message, "stop");
    }
    setTimeout(poll, gate ? 15000 : 5000);
  }
  poll();
})();
`;

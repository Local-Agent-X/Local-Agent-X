// Wave-2 soak battery: drives real chat turns against an ISOLATED headless
// LAX server (LAX_DATA_DIR=$HOME/lax-soak) to collect mechanism telemetry for
// C1 (anchored context sizing), E9 (read dedup + external-change diffs) and
// D2 (end-of-turn extraction gate). B2 (circuit breaker) is deliberately not
// live-soaked: tripping it requires breaking the global provider, which kills
// the turns themselves before one op can accrue 3 failures — its semantics
// are mutation-proven in unit tests. This battery asserts it stays SILENT.
//
// Isolation: fresh data dir, own port, own workspace. Provider settings are
// copied from the real ~/.lax/settings.json (read-only) so the soak runs the
// same provider path as daily use; Anthropic CLI auth rides on ~/.claude.
// Real ~/.lax is never written.
//
// Usage: node eval/wave2-soak/run.mjs   (from repo root; server spawned here)
// Knobs: SOAK_DIR, SOAK_PORT, SOAK_CONCURRENCY, SOAK_ANCHOR_SESSIONS, SOAK_TURN_TIMEOUT_MS

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdtempSync, appendFileSync, openSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Runs from scratchpad during development; point at the repo explicitly.
const REPO_ROOT = process.env.SOAK_REPO_ROOT || "/Users/dad/Projects/Local-Agent-X";
const SOAK_DIR = process.env.SOAK_DIR || join(homedir(), "lax-soak");
const PORT = Number(process.env.SOAK_PORT || 7017);
const BASE = `http://127.0.0.1:${PORT}`;
const CONCURRENCY = Number(process.env.SOAK_CONCURRENCY || 3);
const ANCHOR_SESSIONS = Number(process.env.SOAK_ANCHOR_SESSIONS || 4);
const TURN_TIMEOUT = Number(process.env.SOAK_TURN_TIMEOUT_MS || 240_000);
const RUN_TAG = `soak2-${Date.now().toString(36)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let H = null; // auth headers, set after config.json exists

// ── server lifecycle ─────────────────────────────────────────────────────────

async function portBusy() {
  try { await fetch(`${BASE}/api/health`); return true; } catch { return false; }
}

let child = null;
async function startServer() {
  if (await portBusy()) throw new Error(`port ${PORT} already serving — refusing to double-start (starvation hazard)`);
  mkdirSync(SOAK_DIR, { recursive: true });
  mkdirSync(join(SOAK_DIR, "workspace"), { recursive: true });
  // Same provider/model as daily use, without touching the real data dir.
  const realSettings = join(homedir(), ".lax", "settings.json");
  const soakSettings = join(SOAK_DIR, "settings.json");
  if (existsSync(realSettings) && !existsSync(soakSettings)) copyFileSync(realSettings, soakSettings);

  const logFd = openSync(join(SOAK_DIR, "boot.log"), "a");
  child = spawn(process.execPath, ["--import=tsx", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LAX_DATA_DIR: SOAK_DIR,
      LAX_PORT: String(PORT),
      LAX_WORKSPACE: join(SOAK_DIR, "workspace"),
      CANONICAL_LOOP_SOAK: "1",
    },
    stdio: ["ignore", logFd, logFd],
  });
  child.on("exit", (code, sig) => { if (!shuttingDown) console.error(`!! server exited early code=${code} sig=${sig}`); });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const cfgPath = join(SOAK_DIR, "config.json");
    if (existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        if (cfg.authToken) {
          H = { Authorization: `Bearer ${cfg.authToken}`, "Content-Type": "application/json" };
          const r = await fetch(`${BASE}/api/health`, { headers: H });
          if (r.ok) return;
        }
      } catch { /* config mid-write */ }
    }
    await sleep(1000);
  }
  throw new Error("server did not become healthy in 90s — see boot.log");
}

let shuttingDown = false;
async function stopServer() {
  shuttingDown = true;
  if (!child) return;
  child.kill("SIGTERM");
  const gone = await Promise.race([
    new Promise((r) => child.once("exit", () => r(true))),
    sleep(15_000).then(() => false),
  ]);
  if (!gone) { console.error("!! SIGTERM timeout, killing"); child.kill("SIGKILL"); }
}

// ── SSE driver (mirrors eval/grok-coding-parity driveChat, plus telemetry) ──

async function driveChat(message, sessionId) {
  const out = { text: "", err: "", opId: null, tools: [], toolEnds: [], contextStatus: [], usage: null, stopped: null, secs: 0 };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: H, body: JSON.stringify({ message, sessionId }), signal: ac.signal });
    if (!res.ok) { out.err = `HTTP ${res.status}`; }
    else {
      let buf = "";
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let ev; try { ev = JSON.parse(payload); } catch { continue; }
          switch (ev.type) {
            case "stream": if (typeof ev.delta === "string") out.text += ev.delta; else if (typeof ev.text === "string") out.text = ev.text; break;
            case "chat_op_started": out.opId = ev.opId; break;
            case "tool_start": if (ev.toolName) out.tools.push(ev.toolName); break;
            case "tool_end": out.toolEnds.push({ tool: ev.toolName, status: ev.status, result: typeof ev.result === "string" ? ev.result.slice(0, 400) : null }); break;
            case "context_status": out.contextStatus.push({ pct: ev.percentage, used: ev.usedTokens, max: ev.maxTokens, level: ev.level, compacted: ev.compacted ?? null }); break;
            case "done": out.usage = ev.usage ?? null; break;
            case "stopped": out.stopped = ev.reason ?? "stopped"; break;
            case "error": if (ev.message) out.err = ev.message; break;
          }
        }
      }
    }
  } catch (e) { out.err = e.name === "AbortError" ? `timeout ${TURN_TIMEOUT}ms` : e.message; }
  clearTimeout(timer);
  out.text = out.text.trim();
  out.secs = Number(((Date.now() - t0) / 1000).toFixed(1));
  return out;
}

// ── scenario helpers ─────────────────────────────────────────────────────────

const WORDS = "harness context anchor estimate ledger seam refute worktree canonical breaker snapshot manifest cursor drain gate probe stub nudge sweep clamp stamp".split(" ");
function filler(chars, seed) {
  let s = seed * 2654435761 >>> 0, outParts = [];
  let len = 0;
  while (len < chars) {
    s = (s * 1103515245 + 12345) >>> 0;
    const w = WORDS[s % WORDS.length];
    outParts.push(w); len += w.length + 1;
  }
  return outParts.join(" ");
}

const results = { tag: RUN_TAG, startedAt: new Date().toISOString(), soakDir: SOAK_DIR, sessions: [] };

async function anchorSession(i) {
  const sid = `${RUN_TAG}-anchor-${i}`;
  const rec = { sid, kind: "anchor", turns: [] };
  for (let t = 0; t < 12; t++) {
    const msg = t === 0
      ? "I'm going to paste several large notes over the next messages. For each, reply with exactly one short sentence acknowledging it. No tools needed.\n\n" + filler(9000, i * 100 + t)
      : `Note ${t}:\n\n` + filler(9000, i * 100 + t) + "\n\nOne-sentence acknowledgement only.";
    const r = await driveChat(msg, sid);
    rec.turns.push({ t, opId: r.opId, err: r.err, stopped: r.stopped, secs: r.secs, contextStatus: r.contextStatus, usage: r.usage, tools: r.tools });
    if (r.err) break;
    const compacted = r.contextStatus.some((c) => c.compacted);
    if (compacted) { rec.sawCompaction = true; if (t >= 8) break; }
  }
  results.sessions.push(rec);
}

function makeScratchProject(i) {
  const dir = mkdtempSync(join(homedir(), `lax-soak-proj-${i}-`));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), `export function alpha(x: number): number {\n  return x * 2;\n}\n// v1\n`);
  writeFileSync(join(dir, "src", "b.ts"), `export function beta(s: string): string {\n  return s.toUpperCase();\n}\n// v1\n`);
  writeFileSync(join(dir, "src", "c.ts"), `export const GAMMA = 42;\n// stable file, never externally modified\n`);
  return dir;
}

async function churnSession(i) {
  const dir = makeScratchProject(i);
  const sid = `${RUN_TAG}-churn-${i}`;
  const rec = { sid, kind: "churn", dir, turns: [] };
  const push = (label, r) => rec.turns.push({ label, opId: r.opId, err: r.err, secs: r.secs, tools: r.tools, toolEnds: r.toolEnds, text: r.text.slice(0, 500) });

  push("read-all", await driveChat(`Read ${dir}/src/a.ts, ${dir}/src/b.ts and ${dir}/src/c.ts in full and summarize each in one line.`, sid));
  // External modification between turns — the exact editor-autosave shape E9 watches.
  writeFileSync(join(dir, "src", "a.ts"), `export function alpha(x: number): number {\n  return x * 3; // changed externally\n}\nexport const ALPHA_VERSION = 2;\n// v2\n`);
  push("after-external-change", await driveChat("Without doing anything else: did anything change in those files since you read them? One line.", sid));
  push("reread-changed", await driveChat(`Read ${dir}/src/a.ts again and tell me its exact current line count.`, sid));
  push("reread-unchanged", await driveChat(`Read ${dir}/src/c.ts again — has it changed? One line.`, sid));
  writeFileSync(join(dir, "src", "b.ts"), `export function beta(s: string): string {\n  return s.toLowerCase(); // flipped externally\n}\n// v2\n`);
  push("second-change", await driveChat("Same question: any file changes since your last reads? One line.", sid));
  results.sessions.push(rec);
}

async function curateSession(i, curate) {
  const sid = `${RUN_TAG}-${curate ? "curate" : "plain"}-${i}`;
  const rec = { sid, kind: curate ? "curate" : "plain", turns: [] };
  const msgs = curate
    ? [
        ["Remember that I prefer tabs over spaces in all my projects.", "Thanks. What's one downside of tabs? One line."],
        ["Never suggest running npm install without asking me first — remember that.", "Got a one-line alternative you'd suggest instead?"],
        ["Correction: I use pnpm, not npm — remember it.", "One-line: why do people like pnpm?"],
      ][i % 3]
    : [
        ["What's a good name for a CLI tool that syncs dotfiles? One suggestion.", "One more, different vibe."],
        ["Give me one sentence explaining what a git worktree is.", "And one common gotcha, one line."],
        ["Suggest a single emoji for a release announcement.", "And one for a hotfix."],
      ][i % 3];
  for (const [t, m] of msgs.entries()) {
    const r = await driveChat(m, sid);
    rec.turns.push({ t, opId: r.opId, err: r.err, secs: r.secs });
    if (r.err) break;
  }
  results.sessions.push(rec);
}

async function pool(tasks, n) {
  const q = [...tasks];
  await Promise.all(Array.from({ length: n }, async () => {
    while (q.length) { const t = q.shift(); try { await t(); } catch (e) { console.error("task error:", e.message); } }
  }));
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log(`[soak] tag=${RUN_TAG} dir=${SOAK_DIR} port=${PORT}`);
await startServer();
console.log("[soak] server healthy");
try {
  const s = await fetch(`${BASE}/api/settings`, { headers: H }).then((r) => r.json());
  console.log(`[soak] provider=${s.provider} model=${s.model}`);
  results.provider = `${s.provider}/${s.model}`;

  const tasks = [];
  for (let i = 0; i < ANCHOR_SESSIONS; i++) tasks.push(() => anchorSession(i));
  for (let i = 0; i < 3; i++) tasks.push(() => churnSession(i));
  for (let i = 0; i < 3; i++) tasks.push(() => curateSession(i, true));
  for (let i = 0; i < 3; i++) tasks.push(() => curateSession(i, false));
  await pool(tasks, CONCURRENCY);

  console.log("[soak] sessions done; letting extraction drain 10s");
  await sleep(10_000);
} finally {
  await stopServer();
  results.finishedAt = new Date().toISOString();
  const outPath = join(SOAK_DIR, `battery-${RUN_TAG}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`[soak] raw results → ${outPath}`);
}

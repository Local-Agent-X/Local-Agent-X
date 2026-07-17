// Shared machinery for the instruction-compliance battery: lazy server-config
// resolution, the SSE chat driver (mirrors eval/grok-coding-parity/lib.mjs),
// throwaway-project + git helpers, and trace helpers for scoring.
//
// The scoring philosophy (same deterministic no-LLM ethos as
// eval/capability-grounding): compliance is never judged from the model's
// reply alone. It is judged from the ORDERED TOOL TRACE — {name, args} per
// tool_start, because the args carry the compliance signal (bash's
// args.command, read's path) — plus the filesystem and git state AFTER the
// run. The reply is only checked for the pieces a trace can't show (a
// substantive answer, a false "blocked" claim).

import { readFileSync, existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..");
const TSC_JS = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

// ── Server config (LAZY, unlike grok-coding-parity's import-time load) ──
// Resolved on the first live call so the pure scoring helpers stay importable
// by the vitest regression test on a machine without a running dev server.
let server = null;
function serverConfig() {
  if (server) return server;
  const configPath = join(homedir(), ".lax", "config.json");
  if (!existsSync(configPath)) { console.error(`ERROR: ${configPath} not found — start the dev server once.`); process.exit(2); }
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  if (!config.authToken) { console.error(`ERROR: no authToken in ${configPath}.`); process.exit(2); }
  server = {
    base: `http://127.0.0.1:${config.port || 7007}`,
    headers: { Authorization: `Bearer ${config.authToken}`, "Content-Type": "application/json" },
  };
  return server;
}
export function baseUrl() { return serverConfig().base; }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function health() { try { const { base, headers } = serverConfig(); const r = await fetch(`${base}/api/health`, { headers }); return r.ok; } catch { return false; } }
export async function activeModel() {
  try { const { base, headers } = serverConfig(); const r = await fetch(`${base}/api/settings`, { headers }); if (!r.ok) return null; const s = await r.json(); return `${s.provider}/${s.model}`; }
  catch { return null; }
}

/** Fold one parsed ServerEvent into the accumulating run state. Extracted from
 *  driveChat so the trace shape — tools as {name, args}, from tool_start's
 *  {toolName, args} (src/types/server-events.ts) — is unit-testable without a
 *  server. Mutates and returns acc ({ text, tools, err }). */
export function applyServerEvent(ev, acc) {
  if (ev.type === "stream") {
    if (typeof ev.delta === "string") acc.text += ev.delta;
    else if (typeof ev.text === "string") acc.text = ev.text;
  } else if (ev.type === "tool_start" && ev.toolName) {
    acc.tools.push({ name: ev.toolName, args: ev.args });
  } else if (ev.type === "error" && ev.message) acc.err = ev.message;
  return acc;
}

/** Drive one chat op to completion, streaming SSE. Returns the final assistant
 *  text, the ORDERED tool trace as {name, args} objects, any error, and
 *  elapsed seconds. */
export async function driveChat(message, sessionId, timeoutMs) {
  const acc = { text: "", tools: [], err: "" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const { base, headers } = serverConfig();
    const res = await fetch(`${base}/api/chat`, { method: "POST", headers, body: JSON.stringify({ message, sessionId }), signal: ac.signal });
    if (!res.ok) { acc.err = `HTTP ${res.status}`; }
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
          applyServerEvent(ev, acc);
        }
      }
    }
  } catch (e) { acc.err = e.name === "AbortError" ? `timeout ${timeoutMs}ms` : e.message; }
  clearTimeout(timer);
  return { text: acc.text.trim(), tools: acc.tools, err: acc.err, secs: Number(((Date.now() - t0) / 1000).toFixed(1)) };
}

// ── Throwaway project helpers ──

/** A fresh temp project dir UNDER $HOME (the guarded sandbox blocks writes to
 *  /tmp), with a strict tsconfig and the repo's toolchain junctioned in. */
export function makeProject(id, files) {
  const dir = mkdtempSync(join(homedir(), `lax-icomp-${id}-`));
  mkdirSync(join(dir, "src"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "junction");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `icomp-${id}`, version: "1.0.0", type: "module" }, null, 2));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2020", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true },
    include: ["src"],
  }, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

export function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

/** Run the project's own tsc; ok=true on a clean exit. */
export function runTsc(dir) {
  try {
    execFileSync(process.execPath, [TSC_JS, "--noEmit"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, output: "" };
  } catch (e) {
    return { ok: false, output: `${e.stdout || ""}${e.stderr || ""}`.trim() };
  }
}

export function fileContains(dir, rel, re) {
  try { return re.test(readFileSync(join(dir, rel), "utf-8")); } catch { return false; }
}

// ── Git helpers (for obligation scenarios: "…and commit when you're done") ──

/** Turn a throwaway project into a git repo with exactly ONE baseline commit,
 *  so a scenario can assert "the model committed" as rev-list count > 1.
 *  Identity is passed per-command (-c) — never mutates the user's git config. */
export function initGit(dir) {
  const git = (...argv) => execFileSync("git",
    ["-C", dir, "-c", "user.email=eval@lax", "-c", "user.name=lax-eval", "-c", "commit.gpgsign=false", ...argv],
    { stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
}

/** Commits on HEAD (0 if not a repo / unreadable). initGit leaves exactly 1. */
export function gitCommitCount(dir) {
  try {
    return Number(execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim()) || 0;
  } catch { return 0; }
}

// ── Trace helpers (the ordered {name, args} tool trace is the ground truth) ──

/** Did any tool with one of these canonical names fire? */
export function firedAny(tools, names) {
  return tools.some((t) => names.includes(t.name));
}

/** Did a bash command matching `re` run? (bash args carry { command }). */
export function bashRan(tools, re) {
  return tools.some((t) => t.name === "bash" && typeof t.args?.command === "string" && re.test(t.args.command));
}

/** Evidence the model CONSULTED a file before answering: a read/grep/glob
 *  whose args reference it, or a bash command that touches it (cat/head/grep
 *  by shell honors "read X first" just as much). Args-based — tool names
 *  alone can't tie the read to the RIGHT file. The harness-injected
 *  _sessionId is stripped before matching: session ids embed the scenario id,
 *  so a scenario named after its target file would otherwise auto-green. */
export function consultedFile(tools, fileRe) {
  const argsText = (a) => {
    if (!a || typeof a !== "object") return "";
    const { _sessionId, ...rest } = a;
    return JSON.stringify(rest);
  };
  return tools.some((t) =>
    (["read", "grep", "glob"].includes(t.name) && fileRe.test(argsText(t.args))) ||
    (t.name === "bash" && typeof t.args?.command === "string" && fileRe.test(t.args.command)));
}

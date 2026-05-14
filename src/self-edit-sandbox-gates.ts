/**
 * Self-edit sandbox gates — build, bind, smoke. Plus the claude -p spawner.
 *
 * Split from self-edit-sandbox.ts to keep both files under the 400-LOC limit.
 * All exports here are called only from self-edit-sandbox.ts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { runCommandInWorktree, getWorktreePath } from "./agency/worktree.js";
import { npmAugmentedEnv } from "./anthropic-client/cli-path.js";

import { createLogger } from "./logger.js";
const logger = createLogger("self-edit.sandbox-gates");

// ── Config ─────────────────────────────────────────────────────────────────

export const BUILD_TIMEOUT_MS = 5 * 60_000;
export const BIND_TIMEOUT_MS = 60_000;
export const SMOKE_TIMEOUT_MS = 30_000;
export const CLAUDE_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 4000;

export interface GateResult {
  ok: boolean;
  /** Skipped if a previous gate failed. */
  skipped: boolean;
  durationMs: number;
  detail: string;
}

export const SKIPPED_GATE: GateResult = { ok: false, skipped: true, durationMs: 0, detail: "skipped (earlier gate failed)" };

// ── Gate 1: build ──────────────────────────────────────────────────────────

export function gateBuild(name: string): GateResult {
  const r = runCommandInWorktree(name, { command: "npm run build", timeoutMs: BUILD_TIMEOUT_MS });
  return {
    ok: r.ok,
    skipped: false,
    durationMs: r.durationMs,
    detail: r.ok ? "build passed" : (r.stderr || r.stdout || "build failed (no output)").slice(-1500),
  };
}

// ── Gate 2: bind ───────────────────────────────────────────────────────────
//
// Spawns the worktree's server on a probe port and waits up to BIND_TIMEOUT_MS
// for the port to bind. Returns the spawned process so the caller can keep
// it alive for the smoke gate (and kill it in the finally).

export async function gateBind(name: string, port: number, signal?: AbortSignal): Promise<{ result: GateResult; proc: ChildProcess | null }> {
  const start = Date.now();
  const wt = getWorktreePath(name);
  if (!wt) {
    return { result: { ok: false, skipped: false, durationMs: 0, detail: "worktree path not found" }, proc: null };
  }
  const proc = spawn("npm", ["run", "dev:nowatch"], {
    cwd: wt,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    // LAX_SKIP_INTEGRITY=1 — bypass enforceStartupIntegrity() in the
    // probe. The probe is short-lived and only needs to verify the
    // server can bind a port + answer auth. The integrity check kills
    // the probe (exit 2) when arikernel files are AV-quarantined,
    // which would block self_edit even though the actual edit is
    // unrelated to those files. The check still runs on the REAL
    // server boot (parent process) — this only loosens it for probes.
    env: { ...npmAugmentedEnv(), LAX_PORT: String(port), LAX_DISABLE_BACKGROUND_JOBS: "1", LAX_SKIP_INTEGRITY: "1" },
  });

  let probeStdout = "";
  let probeStderr = "";
  proc.stdout?.on("data", (c: Buffer) => { probeStdout += c.toString(); if (probeStdout.length > 8000) probeStdout = probeStdout.slice(-8000); });
  proc.stderr?.on("data", (c: Buffer) => { probeStderr += c.toString(); if (probeStderr.length > 8000) probeStderr = probeStderr.slice(-8000); });

  const deadline = Date.now() + BIND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      try { proc.kill("SIGKILL"); } catch {}
      return { result: { ok: false, skipped: false, durationMs: Date.now() - start, detail: "aborted" }, proc: null };
    }
    if (proc.exitCode !== null) {
      return {
        result: {
          ok: false, skipped: false, durationMs: Date.now() - start,
          detail: `probe exited (code ${proc.exitCode}) before binding\nstdout: ${probeStdout.slice(-800)}\nstderr: ${probeStderr.slice(-800)}`,
        },
        proc: null,
      };
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(1000) });
      // 200 = bound and answering; 401 = bound and rejecting auth — both prove bind success
      if (r.status === 200 || r.status === 401) {
        return { result: { ok: true, skipped: false, durationMs: Date.now() - start, detail: `bound on port ${port}` }, proc };
      }
    } catch { /* not yet bound */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  try { proc.kill("SIGKILL"); } catch {}
  return {
    result: {
      ok: false, skipped: false, durationMs: Date.now() - start,
      detail: `did not bind on port ${port} within ${BIND_TIMEOUT_MS / 1000}s\nstdout: ${probeStdout.slice(-800)}\nstderr: ${probeStderr.slice(-800)}`,
    },
    proc: null,
  };
}

// ── Gate 3: smoke ──────────────────────────────────────────────────────────
//
// POST /api/chat to the probe instance with a tiny ping. Drains a small
// chunk of the SSE stream to confirm the agent loop actually ran. Catches
// the case where the server boots but the agent code path is broken.

export async function gateSmoke(port: number, authToken: string, signal?: AbortSignal): Promise<GateResult> {
  const start = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
      body: JSON.stringify({ message: "ping", sessionId: "selfedit-smoke" }),
      signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      const body = await res.text().catch(() => "");
      return { ok: false, skipped: false, durationMs: Date.now() - start, detail: `chat returned ${res.status}: ${body.slice(0, 600)}` };
    }
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      const drainDeadline = Date.now() + 10_000;
      while (Date.now() < drainDeadline) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.byteLength || 0;
        if (total > 50) break; // any non-trivial response is enough proof
        if (signal?.aborted) break;
      }
      reader.cancel().catch(() => {});
    }
    if (total < 1) {
      return { ok: false, skipped: false, durationMs: Date.now() - start, detail: "chat returned 200 but stream was empty" };
    }
    return { ok: true, skipped: false, durationMs: Date.now() - start, detail: `chat replied (${total} bytes)` };
  } catch (e) {
    return { ok: false, skipped: false, durationMs: Date.now() - start, detail: `smoke test threw: ${(e as Error).message}` };
  }
}

// ── claude -p spawner ──────────────────────────────────────────────────────

export function spawnClaude(cwd: string, prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveP) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("claude", [
      "-p",
      "--model", "claude-opus-4-7",
      "--permission-mode", "bypassPermissions",
      "--no-session-persistence",
      "--output-format", "text",
    ], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: npmAugmentedEnv(),
    });
    // On Windows we spawn through a shell wrapper (shell:true above), so
    // proc.kill kills the shell — claude.exe stays orphaned as a detached
    // child. Use the same taskkill /F /T tree-kill pattern killProbe uses
    // (below) so the actual claude subprocess dies on cancel/timeout.
    // Without this, hitting Stop during self_edit leaves claude running
    // for minutes; the worker never releases; the next chat turn never
    // gets leased.
    const killTree = () => {
      try { proc.kill("SIGTERM"); } catch {}
      if (process.platform === "win32" && proc.pid) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require("node:child_process").execSync(`taskkill /PID ${proc.pid} /F /T`, { stdio: "ignore", windowsHide: true });
        } catch {}
      }
    };
    const abortListener = killTree;
    signal?.addEventListener("abort", abortListener);
    const timer = setTimeout(killTree, CLAUDE_TIMEOUT_MS);
    proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); if (stdout.length > MAX_OUTPUT_CHARS * 3) stdout = stdout.slice(-MAX_OUTPUT_CHARS * 3); });
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);
      if (code !== 0 && !stdout.trim()) {
        resolveP(`(claude -p exited ${code}, no output)\n${stderr.slice(0, 600)}`);
      } else {
        resolveP(stdout.trim().slice(0, MAX_OUTPUT_CHARS));
      }
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortListener);
      resolveP(`(claude -p spawn error: ${e.message})`);
    });
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}

// ── Probe process cleanup helper ───────────────────────────────────────────

export function killProbe(proc: ChildProcess | null): void {
  if (!proc) return;
  try { proc.kill("SIGKILL"); } catch {}
  if (process.platform === "win32" && proc.pid) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:child_process").execSync(`taskkill /PID ${proc.pid} /F /T`, { stdio: "ignore", windowsHide: true });
    } catch {}
  }
  void logger; // silence unused-import lint
}

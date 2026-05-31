/**
 * Self-edit sandbox gates — build, bind, smoke. Plus the claude -p spawner.
 *
 * Split from self-edit-sandbox.ts to keep both files under the 400-LOC limit.
 * All exports here are called only from self-edit-sandbox.ts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandInWorktree, getWorktreePath, getWorktreeChangedFiles, isolateNodeModules, changedFilesTouchDeps } from "./agency/worktree.js";
import { killProcessTree } from "./process-tree-kill.js";
import { runSmokeAssertions } from "./self-edit-smoke-suite.js";
import { buildSelfEditChildEnv } from "./self-edit/child-env.js";

import { createLogger } from "./logger.js";
const logger = createLogger("self-edit.sandbox-gates");

// ── Config ─────────────────────────────────────────────────────────────────

export const BUILD_TIMEOUT_MS = 5 * 60_000;
export const BIND_TIMEOUT_MS = 60_000;
export const SMOKE_TIMEOUT_MS = 30_000;

export interface GateResult {
  ok: boolean;
  /** Skipped if a previous gate failed. */
  skipped: boolean;
  durationMs: number;
  detail: string;
}

export const SKIPPED_GATE: GateResult = { ok: false, skipped: true, durationMs: 0, detail: "skipped (earlier gate failed)" };

// ── Gate 0: deps ─────────────────────────────────────────────────────────────
//
// Lazy isolation. If the self_edit didn't touch a dependency manifest, the
// shared node_modules junction is harmless and we skip (skipped = passed-by-
// not-applying). If deps DID change, installing through the junction would
// corrupt the parent repo's real node_modules — so we drop the junction
// (isolateNodeModules) and run a real `npm ci` in an isolated dir. A failing
// install blocks the merge.

export function gateDeps(name: string): GateResult {
  const changed = getWorktreeChangedFiles(name);
  if (!changedFilesTouchDeps(changed)) {
    return { ok: true, skipped: true, durationMs: 0, detail: "no dependency changes" };
  }
  const isolate = isolateNodeModules(name);
  if (!isolate.ok) {
    return { ok: false, skipped: false, durationMs: 0, detail: isolate.detail };
  }
  const r = runCommandInWorktree(name, { command: "npm ci", timeoutMs: BUILD_TIMEOUT_MS });
  return {
    ok: r.ok,
    skipped: false,
    durationMs: r.durationMs,
    detail: r.ok ? "isolated npm ci passed" : (r.stderr || r.stdout || "npm ci failed").slice(-1500),
  };
}

// ── Gate 1: build ──────────────────────────────────────────────────────────

export function gateBuild(name: string): GateResult {
  // Scrubbed env: `npm run build` runs the worktree's build scripts (authored
  // by the untrusted self_edit child). It needs no credentials — strip them so
  // a malicious build script can't read+exfil the server's secrets.
  const r = runCommandInWorktree(name, { command: "npm run build", timeoutMs: BUILD_TIMEOUT_MS, env: buildSelfEditChildEnv() });
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

export async function gateBind(name: string, port: number, authToken: string, signal?: AbortSignal): Promise<{ result: GateResult; proc: ChildProcess | null; dataDir: string | null }> {
  const start = Date.now();
  const wt = getWorktreePath(name);
  if (!wt) {
    return { result: { ok: false, skipped: false, durationMs: 0, detail: "worktree path not found" }, proc: null, dataDir: null };
  }
  // Disposable data dir — the probe boots a real server, so without this it
  // would point LAX_DATA_DIR at the user's REAL state (live SQLite, memory,
  // secrets) and a smoke test could mutate it. A fresh temp dir isolates the
  // probe; the caller removes it in its finally. We still pass the parent's
  // LAX_AUTH_TOKEN so the fresh data dir adopts the same token (config.ts
  // applies the env override before its generate-if-empty branch) and the
  // smoke gate can authenticate POST /api/chat.
  //
  // LAX_INTEGRITY_WARN_ONLY=1 — downgrade enforceStartupIntegrity() to a
  // non-fatal warning in the probe instead of a hard skip. The probe is
  // short-lived (a few seconds, just verifies port bind + auth route), so a
  // dropped/AV-quarantined arikernel file shouldn't kill it (exit 2) and
  // block an unrelated self_edit — but unlike a full skip, the missing file
  // is still logged as a warning so it stays visible. The REAL server boot
  // (parent process) still enforces integrity normally.
  const dataDir = mkdtempSync(join(tmpdir(), "lax-probe-"));
  // Boot the COMPILED build (`npm start` → node dist/index.js), not
  // `dev:nowatch` (tsx). The build gate just produced dist/; tsx would instead
  // cold-recompile the whole codebase from scratch (esbuild caches per project
  // path, and each worktree is a new path), which on a large tree blows past
  // BIND_TIMEOUT_MS and fails the gate for slow boot rather than real breakage.
  // dist boots in seconds and is the exact artifact `npm start` ships.
  //
  // Scrubbed env: the probe BOOTS the full app from the worktree — code the
  // untrusted self_edit child wrote — so it's the richest exfil runtime (agent
  // loop, fetch, the lot). buildSelfEditChildEnv strips the server's bystander
  // credentials (GitHub/AWS/Stripe/…); the probe runs on a fresh empty data dir
  // and defaults to the anthropic provider, so the only provider cred it can
  // use is the Anthropic auth this scrub already passes through — smoke is
  // unaffected. The explicit LAX_* overrides below are layered on top.
  const proc = spawn("npm", ["start"], {
    cwd: wt,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    // LAX_SELF_EDIT_PROBE=1 — tells the booting probe it's running from a
    // worktree INSIDE %TEMP%/lax-worktrees, so it must NOT run the orphan
    // worktree sweep (which would unlink the node_modules junction it's
    // currently booting on and kill itself mid-boot).
    env: { ...buildSelfEditChildEnv(), LAX_PORT: String(port), LAX_DISABLE_BACKGROUND_JOBS: "1", LAX_DATA_DIR: dataDir, LAX_AUTH_TOKEN: authToken, LAX_INTEGRITY_WARN_ONLY: "1", LAX_SELF_EDIT_PROBE: "1" },
  });

  let probeStdout = "";
  let probeStderr = "";
  proc.stdout?.on("data", (c: Buffer) => { probeStdout += c.toString(); if (probeStdout.length > 8000) probeStdout = probeStdout.slice(-8000); });
  proc.stderr?.on("data", (c: Buffer) => { probeStderr += c.toString(); if (probeStderr.length > 8000) probeStderr = probeStderr.slice(-8000); });

  const deadline = Date.now() + BIND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      killProcessTree(proc, "SIGKILL");
      return { result: { ok: false, skipped: false, durationMs: Date.now() - start, detail: "aborted" }, proc: null, dataDir };
    }
    if (proc.exitCode !== null) {
      return {
        result: {
          ok: false, skipped: false, durationMs: Date.now() - start,
          detail: `probe exited (code ${proc.exitCode}) before binding\nstdout: ${probeStdout.slice(-800)}\nstderr: ${probeStderr.slice(-800)}`,
        },
        proc: null,
        dataDir,
      };
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(1000) });
      // 200 = bound and answering; 401 = bound and rejecting auth — both prove bind success
      if (r.status === 200 || r.status === 401) {
        return { result: { ok: true, skipped: false, durationMs: Date.now() - start, detail: `bound on port ${port}` }, proc, dataDir };
      }
    } catch { /* not yet bound */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  killProcessTree(proc, "SIGKILL");
  return {
    result: {
      ok: false, skipped: false, durationMs: Date.now() - start,
      detail: `did not bind on port ${port} within ${BIND_TIMEOUT_MS / 1000}s\nstdout: ${probeStdout.slice(-800)}\nstderr: ${probeStderr.slice(-800)}`,
    },
    proc: null,
    dataDir,
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
    const suite = await runSmokeAssertions(port, authToken, signal);
    if (!suite.ok) {
      return { ok: false, skipped: false, durationMs: Date.now() - start, detail: `chat ok but ${suite.detail}` };
    }
    return { ok: true, skipped: false, durationMs: Date.now() - start, detail: `chat replied (${total} bytes) + ${suite.detail}` };
  } catch (e) {
    return { ok: false, skipped: false, durationMs: Date.now() - start, detail: `smoke test threw: ${(e as Error).message}` };
  }
}

// The surgeon spawner (claude / codex / grok, picked from the active provider)
// lives in self-edit/surgeon.ts — runSurgeon(). The sandbox calls it directly.

// ── Probe process cleanup helper ───────────────────────────────────────────

export function killProbe(proc: ChildProcess | null): void {
  killProcessTree(proc, "SIGKILL");
  void logger; // silence unused-import lint
}

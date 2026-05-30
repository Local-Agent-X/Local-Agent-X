/**
 * self_edit sandbox — runs the claude -p subprocess in an isolated worktree
 * and validates that the changes don't brick the agent before merging.
 *
 * Why: self_edit's default mode used to spawn claude -p with bypassPermissions
 * at LAX_REPO_ROOT. If the subprocess wrote broken code, the next server
 * restart loaded broken code, the agent couldn't run, and the user couldn't
 * ask the agent to fix it. Self-bricking.
 *
 * Three gates between subprocess-finished and merge-to-main:
 *   1. Build  — `npm run build` inside worktree must exit 0
 *   2. Bind   — spawn the worktree's server on a probe port; must bind
 *              within 60s. Catches code that compiles but won't boot.
 *   3. Smoke  — POST /api/chat to the probe instance with a tiny ping;
 *              must return 200 + non-empty body within 30s. Catches the
 *              case where the server boots but the agent loop is broken.
 *
 * Only when all three pass do we merge worktree → base. If any fail, the
 * branch is preserved on disk for inspection (per existing mergeWorktree
 * behavior) and main tree stays untouched.
 *
 * Gate implementations + the claude -p spawner live in self-edit-sandbox-gates.ts
 * to keep both files under the 400-LOC limit.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getLaxDir } from "./lax-data-dir.js";
import { type ChildProcess } from "node:child_process";
import { createNamedWorktree, mergeWorktree, getMergeBaseInfo, getBranchHead, revertBranchTo, runRepoBuild } from "./agency/worktree.js";
import { recordMerge } from "./self-edit-rollback.js";
import { gateDeps, gateBuild, gateBind, gateSmoke, spawnClaude, killProbe, SKIPPED_GATE, type GateResult } from "./self-edit-sandbox-gates.js";

import { createLogger } from "./logger.js";
const logger = createLogger("self-edit.sandbox");

// ── Config ─────────────────────────────────────────────────────────────────

const SANDBOX_LOCK = join(getLaxDir(), "self-edit-sandbox.lock");
const PROBE_PORT_MIN = 7100;
const PROBE_PORT_MAX = 7999;

// ── Types ──────────────────────────────────────────────────────────────────

export interface SandboxResult {
  ok: boolean;
  /** Subprocess output (claude -p) — kept for the chat-agent to surface. */
  output: string;
  /** Per-gate status, in order. */
  gates: { deps: GateResult; build: GateResult; bind: GateResult; smoke: GateResult };
  /** Branch the worktree was on (preserved on disk if any gate failed). */
  branchName: string;
  /** Number of files merged on success; null on failure. */
  filesMerged: number | null;
  /** Reason for failure, populated when ok=false. */
  failure?: string;
}

export interface SandboxOpts {
  task: string;
  scopeHint?: string;
  signal?: AbortSignal;
  /** The full prompt to send to claude -p. */
  fullPrompt: string;
  /** Auth token for the probe smoke-test (POST /api/chat). */
  authToken: string;
  /** Optional progress sink — surfaced to the chat UI via tool_progress so the
   *  user can see which gate the sandbox is on. */
  onProgress?: (message: string) => void;
}

// ── Lock ───────────────────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock(): { acquired: boolean; holder?: { pid: number; startedAt: string } } {
  mkdirSync(getLaxDir(), { recursive: true, mode: 0o700 });
  if (existsSync(SANDBOX_LOCK)) {
    try {
      const existing = JSON.parse(readFileSync(SANDBOX_LOCK, "utf-8"));
      if (isPidAlive(existing.pid)) return { acquired: false, holder: existing };
    } catch { /* corrupt lock — reclaim */ }
  }
  writeFileSync(SANDBOX_LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  return { acquired: true };
}

function releaseLock(): void {
  try { if (existsSync(SANDBOX_LOCK)) unlinkSync(SANDBOX_LOCK); } catch {}
}

// ── Naming + port ─────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "edit";
}

function nowSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function pickProbePort(): number {
  const h = createHash("sha1").update(`${process.pid}-${Date.now()}`).digest();
  return PROBE_PORT_MIN + (h.readUInt16BE(0) % (PROBE_PORT_MAX - PROBE_PORT_MIN));
}

// ── Main entry ─────────────────────────────────────────────────────────────

export async function runSelfEditInSandbox(opts: SandboxOpts): Promise<SandboxResult> {
  const lock = acquireLock();
  if (!lock.acquired) {
    return failPreflight(`Another self_edit sandbox is running (pid=${lock.holder?.pid}, started=${lock.holder?.startedAt}). Try again in a moment.`);
  }

  const slug = slugify(opts.task);
  const ts = nowSlug();
  const name = `selfedit-${slug}-${ts}`;
  const branch = `selfedit/${slug}/${ts}`;
  let probeProc: ChildProcess | null = null;
  let probeDataDir: string | null = null;

  const progress = opts.onProgress ?? (() => { /* no-op */ });

  try {
    const wt = createNamedWorktree(name, branch);
    if (!wt) {
      return {
        ok: false, output: "",
        gates: { deps: SKIPPED_GATE, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE },
        branchName: branch, filesMerged: null,
        failure: "Failed to create sandbox worktree — see server logs.",
      };
    }
    logger.info(`[self-edit.sandbox] worktree ready at ${wt.path}`);

    // Run claude -p inside the worktree
    progress("Running source-code repair in sandbox…");
    const claudeOutput = await spawnClaude(wt.path, opts.fullPrompt, opts.signal);

    // Gate 0: deps — isolate node_modules + `npm ci` if a manifest changed.
    // Lazy: skipped (passes) when no dependency change. A failed isolated
    // install blocks the merge before anything else runs.
    logger.info(`[self-edit.sandbox] running deps gate`);
    progress("Deps gate: checking for dependency changes…");
    const deps = gateDeps(name);
    if (!deps.skipped && !deps.ok) {
      logger.warn(`[self-edit.sandbox] deps gate failed: ${deps.detail.slice(0, 200)}`);
      return failResult(claudeOutput, branch, { deps, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE }, `Dependency install failed: ${deps.detail.slice(0, 600)}`);
    }
    logger.info(`[self-edit.sandbox] deps gate ${deps.skipped ? "skipped (no dep changes)" : `passed (${deps.durationMs}ms)`}`);

    // Gate 1: build
    logger.info(`[self-edit.sandbox] running build gate`);
    progress("Build gate: compiling sandboxed code…");
    const build = gateBuild(name);
    if (!build.ok) {
      logger.warn(`[self-edit.sandbox] build gate failed: ${build.detail.slice(0, 200)}`);
      return failResult(claudeOutput, branch, { deps, build, bind: SKIPPED_GATE, smoke: SKIPPED_GATE }, `Build failed: ${build.detail.slice(0, 600)}`);
    }
    logger.info(`[self-edit.sandbox] build gate passed (${build.durationMs}ms)`);

    // Gate 2: bind
    const port = pickProbePort();
    logger.info(`[self-edit.sandbox] running bind gate on port ${port}`);
    progress(`Bind gate: launching probe server on :${port}…`);
    const bindOutcome = await gateBind(name, port, opts.authToken, opts.signal);
    probeProc = bindOutcome.proc;
    probeDataDir = bindOutcome.dataDir;
    if (!bindOutcome.result.ok) {
      logger.warn(`[self-edit.sandbox] bind gate failed: ${bindOutcome.result.detail.slice(0, 200)}`);
      return failResult(claudeOutput, branch, { deps, build, bind: bindOutcome.result, smoke: SKIPPED_GATE }, `Server failed to bind: ${bindOutcome.result.detail.slice(0, 600)}`);
    }
    logger.info(`[self-edit.sandbox] bind gate passed (${bindOutcome.result.durationMs}ms)`);

    // Gate 3: smoke
    logger.info(`[self-edit.sandbox] running smoke gate`);
    progress("Smoke gate: exercising probe agent…");
    const smoke = await gateSmoke(port, opts.authToken, opts.signal);
    if (!smoke.ok) {
      logger.warn(`[self-edit.sandbox] smoke gate failed: ${smoke.detail.slice(0, 200)}`);
      return failResult(claudeOutput, branch, { deps, build, bind: bindOutcome.result, smoke }, `Agent smoke test failed: ${smoke.detail.slice(0, 600)}`);
    }
    logger.info(`[self-edit.sandbox] smoke gate passed (${smoke.durationMs}ms)`);

    // All gates pass — kill probe BEFORE merge so it doesn't hold file handles
    killProbe(probeProc);
    probeProc = null;

    progress("All gates passed — merging into main…");
    // Capture the pre-merge base SHA BEFORE mergeWorktree deletes the registry
    // entry, so a post-merge re-gate failure can revert the base branch.
    const mergeInfo = getMergeBaseInfo(name);
    const merge = mergeWorktree(name);
    if (!merge.merged) {
      return {
        ok: false, output: claudeOutput,
        gates: { deps, build, bind: bindOutcome.result, smoke },
        branchName: branch, filesMerged: null,
        failure: `Gates passed but merge failed: ${merge.error || "unknown"}. Branch ${branch} preserved on disk.`,
      };
    }

    // Re-gate: the merge can combine the worktree branch with main commits no
    // gate ever saw. Rebuild the merged main tree; auto-revert if it fails.
    if (mergeInfo) {
      progress("Re-gate: rebuilding merged main…");
      const rebuilt = runRepoBuild(mergeInfo.repoRoot, 5 * 60_000);
      if (!rebuilt.ok) {
        revertBranchTo(mergeInfo.repoRoot, mergeInfo.baseBranch, mergeInfo.sha);
        return failResult(
          claudeOutput, branch,
          { deps, build, bind: bindOutcome.result, smoke },
          `Merge reverted — post-merge build failed: ${rebuilt.detail.slice(0, 600)}`,
        );
      }
      const postSha = getBranchHead(mergeInfo.repoRoot, mergeInfo.baseBranch);
      recordMerge({
        preSha: mergeInfo.sha,
        postSha,
        baseBranch: mergeInfo.baseBranch,
        repoRoot: mergeInfo.repoRoot,
        files: merge.files,
        ts: new Date().toISOString(),
      });
    }

    return {
      ok: true, output: claudeOutput,
      gates: { deps, build, bind: bindOutcome.result, smoke },
      branchName: branch, filesMerged: merge.files,
    };
  } catch (e) {
    return {
      ok: false, output: "",
      gates: { deps: SKIPPED_GATE, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE },
      branchName: branch, filesMerged: null,
      failure: `Sandbox crashed: ${(e as Error).message}`,
    };
  } finally {
    killProbe(probeProc);
    if (probeDataDir) {
      try { rmSync(probeDataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    // On failure, the worktree+branch are preserved by mergeWorktree (which
    // is NOT called on the fail paths). On success, mergeWorktree already
    // cleaned them up.
    releaseLock();
  }
}

// ── Result helpers ────────────────────────────────────────────────────────

function failPreflight(failure: string): SandboxResult {
  return {
    ok: false, output: "",
    gates: { deps: SKIPPED_GATE, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE },
    branchName: "", filesMerged: null, failure,
  };
}

function failResult(
  output: string,
  branch: string,
  gates: SandboxResult["gates"],
  failure: string,
): SandboxResult {
  return { ok: false, output, gates, branchName: branch, filesMerged: null, failure };
}

/** Pretty-print a SandboxResult as a short summary the chat agent can surface. */
export function formatSandboxResult(r: SandboxResult): string {
  if (r.ok) {
    const g = r.gates;
    return [
      `[OK] self_edit shipped via sandbox`,
      `  branch: ${r.branchName} (merged, ${r.filesMerged} files)`,
      `  gates: deps ${g.deps.skipped ? "skipped" : `${g.deps.durationMs}ms`}, build ${g.build.durationMs}ms, bind ${g.bind.durationMs}ms, smoke ${g.smoke.durationMs}ms`,
      ``,
      `Subprocess output:`,
      r.output || "(empty)",
      ``,
      `Restart the server to apply the changes.`,
    ].join("\n");
  }
  const failedGate =
    !r.gates.deps.skipped && !r.gates.deps.ok ? "deps" :
    !r.gates.build.skipped && !r.gates.build.ok ? "build" :
    !r.gates.bind.skipped && !r.gates.bind.ok ? "bind" :
    !r.gates.smoke.skipped && !r.gates.smoke.ok ? "smoke" : "preflight";
  return [
    `[BLOCKED] self_edit blocked at ${failedGate} gate — main tree untouched`,
    `  ${r.failure || "(unknown failure)"}`,
    r.branchName ? `  branch ${r.branchName} preserved on disk for inspection` : "",
    ``,
    `Subprocess output (informational):`,
    r.output || "(empty)",
  ].filter(Boolean).join("\n");
}

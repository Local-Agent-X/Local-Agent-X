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

import { rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { type ChildProcess } from "node:child_process";
import { createNamedWorktree, mergeWorktree, getMergeBaseInfo, getBranchHead, revertBranchTo, runRepoBuild, getWorktreeChangedFiles, securitySensitiveChangedFiles } from "./agency/worktree.js";
import { recordMerge } from "./self-edit-rollback.js";
import { gateDeps, gateBuild, gateBind, gateSmoke, killProbe, SKIPPED_GATE, type GateResult } from "./self-edit-sandbox-gates.js";
import { runSurgeon, formatSurgeonOutput } from "./self-edit/surgeon.js";
import { acquireGlobalSelfEditLock, releaseGlobalSelfEditLock, formatGlobalLockBusy } from "./self-edit/global-lock.js";
import { fingerprintParentDeps, restoreParentDeps } from "./self-edit/parent-deps-guard.js";
import { scanWorktreeForStagedSecrets } from "./self-edit/exfil-scan.js";
import { redactSecrets } from "./security/secret-scanner.js";

import { createLogger } from "./logger.js";
const logger = createLogger("self-edit.sandbox");

// ── Config ─────────────────────────────────────────────────────────────────

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
  /** True when all gates passed but the merge was deliberately HELD (not a
   *  failure) — currently only the security diff-scope gate (#10), which
   *  requires explicit human review before security/policy/auth changes land. */
  heldForReview?: boolean;
  /** True when this call was refused because another self_edit already holds the
   *  global lock (a second agent acting on the same instruction). NOT a failure
   *  — the caller should just end its turn. Kept distinct from gate failures so
   *  the tool layer can mark it isError:false (no circuit-breaker trip). */
  alreadyRunning?: boolean;
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

// ── Naming + port ─────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "edit";
}

function nowSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Resolve to true if nothing currently holds `port` on 127.0.0.1. */
function isProbePortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Pick a FREE probe port. Hashing pid+time alone (the old behavior) could hand
 * two concurrent probes — e.g. a sandbox bind gate and an autopilot end-of-shift
 * boot proof, which don't share the global lock — the same port. The loser then
 * either fails with a false "did not bind" or, worse, the bind poll hits the
 * OTHER probe and reports a false PASS. We start at the hashed offset (keeps
 * probes spread across the range) and walk forward to the first port nothing is
 * listening on. A tiny TOCTOU window remains between this check and the probe's
 * own listen; the bind gate's exit-code check still catches an EADDRINUSE there.
 */
export async function pickProbePort(): Promise<number> {
  const span = PROBE_PORT_MAX - PROBE_PORT_MIN;
  const h = createHash("sha1").update(`${process.pid}-${Date.now()}`).digest();
  const start = h.readUInt16BE(0) % span;
  for (let i = 0; i < span; i++) {
    const port = PROBE_PORT_MIN + ((start + i) % span);
    if (await isProbePortFree(port)) return port;
  }
  return PROBE_PORT_MIN + start; // whole range busy — let the bind gate surface it
}

// ── Main entry ─────────────────────────────────────────────────────────────

export async function runSelfEditInSandbox(opts: SandboxOpts): Promise<SandboxResult> {
  const lock = acquireGlobalSelfEditLock({ task: opts.task });
  if (!lock.acquired) {
    return {
      ok: false, output: "",
      gates: { deps: SKIPPED_GATE, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE },
      branchName: "", filesMerged: null, alreadyRunning: true,
      failure: formatGlobalLockBusy(lock.holder, opts.task),
    };
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

    // Parent-deps guard (#2): snapshot the parent's node_modules fingerprint
    // BEFORE the subprocess runs. The worktree junctions the parent's real
    // node_modules, so a subprocess that disobeys the no-install instruction
    // corrupts the parent through the junction before the deps gate can react.
    const repoRoot = getMergeBaseInfo(name)?.repoRoot ?? null;
    const depsFingerprintBefore = repoRoot ? fingerprintParentDeps(repoRoot) : null;

    // Run claude -p inside the worktree. Redact any secret-shaped material
    // the child echoed before it reaches chat/logs (defense-in-depth — a
    // child that read a credential shouldn't surface it through stdout).
    progress("Running source-code repair in sandbox…");
    const surgeonOutput = redactSecrets(formatSurgeonOutput(await runSurgeon(wt.path, opts.fullPrompt, opts.signal)));

    // Parent-deps guard (#2): the parent's node_modules must be UNCHANGED across
    // the run (the only legit install — the deps gate — is isolated to the
    // worktree). A changed fingerprint means the subprocess ran an install
    // through the junction. Restore the parent deterministically via `npm ci`
    // and abort: code produced under a violated sandbox contract isn't trusted.
    if (repoRoot && depsFingerprintBefore && fingerprintParentDeps(repoRoot) !== depsFingerprintBefore) {
      logger.error(`[self-edit.sandbox] parent node_modules mutated during subprocess run — restoring via npm ci`);
      progress("Parent deps mutated mid-run — restoring via npm ci…");
      const restored = restoreParentDeps(repoRoot);
      return failResult(
        surgeonOutput, branch,
        { deps: SKIPPED_GATE, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE },
        `Aborted — the subprocess mutated the parent's node_modules mid-run (it ran an install despite instructions). ` +
        `Parent deps restored via npm ci (${restored.ok ? "ok" : `FAILED: ${restored.detail}`}). No changes were merged; re-run the self_edit if still needed.`,
      );
    }

    // Gate 0: deps — isolate node_modules + `npm ci` if a manifest changed.
    // Lazy: skipped (passes) when no dependency change. A failed isolated
    // install blocks the merge before anything else runs.
    logger.info(`[self-edit.sandbox] running deps gate`);
    progress("Deps gate: checking for dependency changes…");
    const deps = gateDeps(name);
    if (!deps.skipped && !deps.ok) {
      logger.warn(`[self-edit.sandbox] deps gate failed: ${deps.detail.slice(0, 200)}`);
      return failResult(surgeonOutput, branch, { deps, build: SKIPPED_GATE, bind: SKIPPED_GATE, smoke: SKIPPED_GATE }, `Dependency install failed: ${deps.detail.slice(0, 600)}`);
    }
    logger.info(`[self-edit.sandbox] deps gate ${deps.skipped ? "skipped (no dep changes)" : `passed (${deps.durationMs}ms)`}`);

    // Gate 1: build
    logger.info(`[self-edit.sandbox] running build gate`);
    progress("Build gate: compiling sandboxed code…");
    const build = gateBuild(name);
    if (!build.ok) {
      logger.warn(`[self-edit.sandbox] build gate failed: ${build.detail.slice(0, 200)}`);
      return failResult(surgeonOutput, branch, { deps, build, bind: SKIPPED_GATE, smoke: SKIPPED_GATE }, `Build failed: ${build.detail.slice(0, 600)}`);
    }
    logger.info(`[self-edit.sandbox] build gate passed (${build.durationMs}ms)`);

    // Gate 2: bind
    const port = await pickProbePort();
    logger.info(`[self-edit.sandbox] running bind gate on port ${port}`);
    progress(`Bind gate: launching probe server on :${port}…`);
    const bindOutcome = await gateBind(name, port, opts.authToken, opts.signal);
    probeProc = bindOutcome.proc;
    probeDataDir = bindOutcome.dataDir;
    if (!bindOutcome.result.ok) {
      logger.warn(`[self-edit.sandbox] bind gate failed: ${bindOutcome.result.detail.slice(0, 200)}`);
      return failResult(surgeonOutput, branch, { deps, build, bind: bindOutcome.result, smoke: SKIPPED_GATE }, `Server failed to bind: ${bindOutcome.result.detail.slice(0, 600)}`);
    }
    logger.info(`[self-edit.sandbox] bind gate passed (${bindOutcome.result.durationMs}ms)`);

    // Gate 3: smoke
    logger.info(`[self-edit.sandbox] running smoke gate`);
    progress("Smoke gate: exercising probe agent…");
    const smoke = await gateSmoke(port, opts.authToken, opts.signal);
    if (!smoke.ok) {
      logger.warn(`[self-edit.sandbox] smoke gate failed: ${smoke.detail.slice(0, 200)}`);
      return failResult(surgeonOutput, branch, { deps, build, bind: bindOutcome.result, smoke }, `Agent smoke test failed: ${smoke.detail.slice(0, 600)}`);
    }
    logger.info(`[self-edit.sandbox] smoke gate passed (${smoke.durationMs}ms)`);

    // All gates pass — kill probe BEFORE merge so it doesn't hold file handles
    killProbe(probeProc);
    probeProc = null;

    // Capture the pre-merge base SHA BEFORE mergeWorktree deletes the registry
    // entry, so a post-merge re-gate failure can revert the base branch.
    const mergeInfo = getMergeBaseInfo(name);

    // Security diff-scope gate (#10): the subprocess runs with
    // bypassPermissions and can rewrite the security / tool-policy / auth layer
    // (or the protected-files manifest). A weakened layer still builds, boots,
    // and chats, so no gate above catches it. Hold such merges for explicit
    // human review — branch preserved on disk, main untouched.
    const securityTouched = securitySensitiveChangedFiles(getWorktreeChangedFiles(name));
    if (securityTouched.length > 0) {
      logger.warn(`[self-edit.sandbox] security-sensitive paths touched — holding merge for human review: ${securityTouched.join(", ")}`);
      const base = mergeInfo?.baseBranch ?? "main";
      return {
        ok: false, output: surgeonOutput,
        gates: { deps, build, bind: bindOutcome.result, smoke },
        branchName: branch, filesMerged: null, heldForReview: true,
        failure:
          `Gates passed, but this self_edit modifies security-sensitive files:\n` +
          securityTouched.map(f => `    - ${f}`).join("\n") + `\n\n` +
          `Auto-merge is BLOCKED — changes to the security / tool-policy / auth layer require explicit human review.\n` +
          `Review:  git diff ${base}...${branch}\n` +
          `Merge:   git checkout ${base} && git merge ${branch}`,
      };
    }

    // Exfil tripwire (confidentiality): a prompt-injected subprocess could
    // stage a scraped credential into the diff (a secret written into a
    // source file rides out on the eventual commit/push). Scan the added
    // content for secret-shaped material; HOLD the merge on a hit — same
    // posture as the security diff-scope gate, branch preserved for review.
    // This catches staged secrets, NOT live network egress (the irreducible
    // residual — see docs/self-edit-hardening.md, M3).
    const exfil = scanWorktreeForStagedSecrets(wt.path);
    if (!exfil.clean) {
      logger.warn(`[self-edit.sandbox] secret-shaped content staged in diff — holding merge for human review: ${exfil.hits.map(h => h.file).join(", ")}`);
      const base = mergeInfo?.baseBranch ?? "main";
      return {
        ok: false, output: surgeonOutput,
        gates: { deps, build, bind: bindOutcome.result, smoke },
        branchName: branch, filesMerged: null, heldForReview: true,
        failure:
          `Gates passed, but this self_edit staged secret-shaped content into the tree:\n` +
          exfil.hits.map(h => `    - ${h.file}: ${h.patterns.join(", ")}`).join("\n") + `\n\n` +
          `Auto-merge is BLOCKED — a prompt-injected subprocess could be staging a credential ` +
          `for exfiltration. Review the diff before merging (false positives are possible — e.g. ` +
          `a test fixture or an edit to the secret-pattern catalog itself):\n` +
          `Review:  git diff ${base}...${branch}\n` +
          `Merge:   git checkout ${base} && git merge ${branch}`,
      };
    }

    progress("All gates passed — merging into main…");
    const merge = mergeWorktree(name);
    if (!merge.merged) {
      return {
        ok: false, output: surgeonOutput,
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
          surgeonOutput, branch,
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
      ok: true, output: surgeonOutput,
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
    releaseGlobalSelfEditLock();
  }
}

// ── Result helpers ────────────────────────────────────────────────────────

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
  // Benign collision — another self_edit already holds the global lock. Not a
  // failure; surface the no-retry notice directly (no "[BLOCKED]" framing).
  if (r.alreadyRunning) return r.failure || "A self_edit is already running — wait for it to finish.";
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
  // Held for review — gates passed, merge deliberately withheld (not a failure).
  if (r.heldForReview) {
    return [
      `[HELD] self_edit passed all gates but was NOT merged — security review required`,
      `  ${r.failure || "(no detail)"}`,
      r.branchName ? `  branch ${r.branchName} preserved on disk` : "",
      ``,
      `Subprocess output (informational):`,
      r.output || "(empty)",
    ].filter(Boolean).join("\n");
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

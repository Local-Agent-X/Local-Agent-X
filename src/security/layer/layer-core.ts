import { resolve, relative, join, isAbsolute } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { SecurityDecision } from "../../types.js";
import { getLaxDir } from "../../lax-data-dir.js";
import { getRuntimeConfig } from "../../config.js";
import { USER_HINTS } from "../../types.js";
import {
  CONTEXT_RESTRICTED_TOOLS,
  WORKTREE_REQUIRED_TOOLS,
  type FileAccessMode,
  type InlineEvalPolicy,
  type ToolCallContext,
} from "./types.js";
import { evaluateFileAccess, realpathDeep, pathIsWithin, canonicalAllowForms } from "./file-access.js";
import { evaluateShellCommandAndPaths } from "./shell-path-guard.js";
import { getSandboxStatus } from "../../sandbox/index.js";
import { evaluateWebFetch, validateUrlWithDns, type EgressMode } from "./network-policy.js";
import { evaluateBrowser as evaluateBrowserAction } from "./browser-egress-eval.js";
import { kernelClassForTool } from "../../ari-kernel/tool-class-map.js";
import { TOOL_PATH_ARGS, type KernelClass, type PathArgSpec } from "../../tool-registry.js";
import { sessionWorkRootOf } from "../../workspace/paths.js";
import { evaluateByKernelClass as evaluateKernelClassPolicy } from "./kernel-class-policy.js";
import { loadEgressMode, loadEgressAllowlist, loadLocalServicePorts, loadFileAccessMode, loadInlineEvalPolicy, manualRuntimeHostPorts } from "./security-config.js";
import { fingerprintSecurityPolicy, parseJsonPathArray, restoreSecurityAllowedPaths, snapshotSecurityRuntime, type SecurityRuntimeIdentity } from "./runtime-state.js";
import { evaluateDelegatedWorktreeGate } from "./delegated-worktree-gate.js";

import { createLogger } from "../../logger.js";
const logger = createLogger("security.layer-core");

// Extract a list of path strings from a JSON-array-string arg (pdf_merge.files).
// A malformed value yields no paths — the tool's own JSON.parse then fails, so
// nothing is opened; never throw out of the security gate.
/**
 * Security layer that evaluates tool calls before execution.
 * Principles:
 * - Fail closed: ambiguity → block
 * - Defense in depth: multiple validation stages
 * - DNS pinning: resolve hostname, then validate resolved IP
 * - No shell metacharacters: reject, don't escape
 * - Path normalization: realpath before checking
 */
export class SecurityLayer {
  /** Port the server is running on — set at startup so SSRF can whitelist self-calls */
  static _selfPort: string = "7007";

  private workspace: string;
  private egressAllowlist: Set<string> = new Set();
  // true once we successfully loaded an egress-allowlist.json file from
  // disk (even if its content is `[]`). false means no file existed —
  // evaluateWebFetch uses this to distinguish "user has explicitly
  // configured an empty allowlist (deny everything)" from "no config
  // present (deny everything with a setup hint)". Previously a missing
  // file silently allowed every public host, which made the advertised
  // egress-allowlist feature fail-open on a default install.
  private egressAllowlistConfigured: boolean = false;
  private egressMode: EgressMode = "permissive";
  // Loopback ports the operator trusts the agent to HTTP-health-check (e.g. a
  // bridge or dev server it started). Loaded from ~/.lax/security.json. Only
  // applies to literal loopback hosts — see evaluateWebFetch.
  private localServicePorts: Set<string> = new Set();
  private sessionAllowedPaths = new Map<string, Set<string>>();
  fileAccessMode: FileAccessMode = "common";
  // Inline-eval (R4-11/R4-13) escape-hatch policy — independent of
  // fileAccessMode so a permissive file default can't silently open it.
  inlineEvalPolicy: InlineEvalPolicy = "refuse";

  /** Allow a path for a session (agent worktree); stored in both lexical + realpathDeep forms (canonicalAllowForms). */
  addAllowedPath(p: string, sessionId?: string): void {
    const key = sessionId || "_global";
    if (!this.sessionAllowedPaths.has(key)) this.sessionAllowedPaths.set(key, new Set());
    for (const form of canonicalAllowForms(p)) this.sessionAllowedPaths.get(key)!.add(form);
  }
  removeAllowedPath(p: string, sessionId?: string): void {
    const set = this.sessionAllowedPaths.get(sessionId || "_global");
    for (const form of canonicalAllowForms(p)) set?.delete(form);
  }
  /** Check if a path is in the allowed set for a session */
  private isInAllowedPaths(realPath: string, sessionId?: string): boolean {
    const check = (key: string) => {
      const paths = this.sessionAllowedPaths.get(key);
      // pathIsWithin (not bare relative().startsWith("..")): a C:-allowed path
      // must not treat a Windows D:\ / UNC target as "inside" (SC-4).
      return paths ? [...paths].some(p => pathIsWithin(p, realPath)) : false;
    };
    return check(sessionId || "_global") || check("_global");
  }

  /** Does this session own a worktree (a non-empty allowed-path set)? The
   *  isolation half of the delegated-shell containment gate. */
  private hasSessionWorktree(sessionId: string | undefined): boolean {
    const key = sessionId || "";
    return this.sessionAllowedPaths.has(key) && this.sessionAllowedPaths.get(key)!.size > 0;
  }

  /** The OS-containment half of the delegated-shell gate: an effectively-confined
   *  sandbox, an operator-acknowledged unconfined host, OR a registered project
   *  work root that scopes the run. This is deliberately the SAME allow-condition
   *  the downstream unattended-shell gate uses (unattended-shell-gate.ts:
   *  `delegatedShellAllowed || scopedDelegatedRun`) — composed from the SAME
   *  canonical primitives (getSandboxStatus + sessionWorkRootOf), not a fork — so
   *  moving the check earlier here can never block a delegated shell the later
   *  gate would have allowed (no regression on an intentionally-unsandboxed host
   *  that acknowledged it, or on work-root-scoped app-build chunk workers). */
  private delegatedShellOsContained(sessionId: string | undefined): boolean {
    return getSandboxStatus().delegatedShellAllowed || !!sessionWorkRootOf(sessionId);
  }

  /** Is a DELEGATED agent's shell effectively contained enough to run its own
   *  build/test (self-verify)? Worktree isolation AND OS containment — the exact
   *  AND enforced by the delegated-shell gate in evaluate(). Exposed so the
   *  SELF_VERIFY redirect only fires when shell is genuinely unavailable to the
   *  delegated agent (no worktree / unconfined-unacknowledged / cron) and stays
   *  silent when the agent CAN run its verify. */
  delegatedShellContained(sessionId: string | undefined): boolean {
    return this.hasSessionWorktree(sessionId) && this.delegatedShellOsContained(sessionId);
  }

  /**
   * Returns true if the target path is "user content" — either inside the
   * workspace/ subdir, or outside the repo entirely (e.g., ~/Documents,
   * ~/Desktop, /tmp, anywhere). Returns false if it's inside the repo but
   * outside workspace/ (= source code).
   *
   * Used by the worktree-isolation gate to allow content-creation workers
   * to write user artifacts (a powerpoint to workspace/, a doc to
   * ~/Documents) without requiring a sandbox — while still requiring one
   * for any write that would touch the agent's own running source.
   */
  private isUserContentPath(targetPath: string): boolean {
    if (!targetPath) return false;
    // Canonicalize BOTH sides before comparing. Two live failure modes:
    // (1) `startsWith(root + "/")` never matched Windows backslash paths,
    // so every repo source file classified as "user content" and delegated
    // write/edit bypassed the worktree gate; (2) a junction/symlink gives
    // one physical dir two spellings (e.g. <repo>/workspace → ~/Documents
    // junction) and classification must not depend on the spelling used.
    const abs = realpathDeep(resolve(targetPath));
    const isUnder = (root: string, p: string) => {
      const rel = relative(root, p);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    // Inside workspace/ → user content
    if (isUnder(realpathDeep(this.workspace), abs)) return true;
    // Outside the repo root entirely → user content (Documents, Desktop, /tmp, etc.)
    const repoRoot = realpathDeep(resolve(this.workspace, ".."));
    if (!isUnder(repoRoot, abs)) return true;
    // Inside repo but not workspace/ → source code (src/, packages/, scripts/, ...)
    return false;
  }

  constructor(workspace: string, fileAccessMode?: FileAccessMode, inlineEvalPolicy?: InlineEvalPolicy) {
    this.workspace = resolve(workspace);
    this.fileAccessMode = fileAccessMode || loadFileAccessMode();
    this.inlineEvalPolicy = inlineEvalPolicy || loadInlineEvalPolicy();
    this.egressMode = loadEgressMode();
    this.localServicePorts = loadLocalServicePorts();
    const egress = loadEgressAllowlist(this.egressMode);
    this.egressAllowlist = egress.allowlist;
    this.egressAllowlistConfigured = egress.configured;
    logger.info(`[security] File access mode: ${this.fileAccessMode}`);
  }

  runtimeIdentity(sessionId?: string): SecurityRuntimeIdentity {
    return snapshotSecurityRuntime(this.workspace, this.fileAccessMode, this.inlineEvalPolicy, this.sessionAllowedPaths, sessionId); }

  runtimePolicyFingerprint(): string {
    // Kill-switches + local-only/supervised toggles are sealed into the policy surface:
    // a container reading different toggles (schema-default fallback or a tampered projected
    // config) recomputes a divergent fingerprint → fails CLOSED (see rehydrateAgentRuntimeSurface).
    const { enableShell, enableHttp, enableBrowser, localOnlyMode, supervisedBrowser } = getRuntimeConfig();
    return fingerprintSecurityPolicy(this.fileAccessMode, this.inlineEvalPolicy, this.egressMode,
      this.egressAllowlistConfigured, [...this.egressAllowlist], [...this.localServicePorts], String(SecurityLayer._selfPort || "7007"),
      { enableShell, enableHttp, enableBrowser, localOnlyMode, supervisedBrowser });
  }

  restoreAllowedPaths(entries: Array<{ sessionId: string; path: string }>): void {
    restoreSecurityAllowedPaths(entries, () => this.sessionAllowedPaths.clear(), (path, sessionId) => this.addAllowedPath(path, sessionId)); }

  setFileAccessMode(mode: FileAccessMode): void {
    this.fileAccessMode = mode;
    try {
      const cfgPath = join(getLaxDir(), "security.json");
      let cfg: Record<string, unknown> = {};
      if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      cfg.fileAccessMode = mode;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
    } catch {}
    logger.info(`[security] File access mode changed to: ${mode}`);
  }

  evaluate(ctx: ToolCallContext): SecurityDecision {
    const { toolName, args } = ctx;

    // Context-based tool tiering: block tools in restricted contexts
    const callCtx = ctx.callContext || "local";
    const restricted = CONTEXT_RESTRICTED_TOOLS[toolName];
    if (restricted && restricted.includes(callCtx)) {
      return {
        allowed: false,
        reason: `Blocked: tool "${toolName}" is not allowed in ${callCtx} context`,
        userHint: USER_HINTS.policy,
      };
    }

    // Delegated agents modifying repo SOURCE (or running an uncontained shell)
    // must be worktree-isolated; user-content writes and doubly-contained
    // self-verify shells pass through. Full rationale lives in the extracted gate.
    if (callCtx === "delegated" && WORKTREE_REQUIRED_TOOLS.has(toolName)) {
      const blocked = evaluateDelegatedWorktreeGate(ctx, {
        hasSessionWorktree: (s) => this.hasSessionWorktree(s),
        delegatedShellOsContained: (s) => this.delegatedShellOsContained(s),
        isUserContentPath: (p) => this.isUserContentPath(p),
      });
      if (blocked) return blocked;
    }

    let decision: SecurityDecision;

    // Tools whose ARGUMENTS carry the routing signal (command, url) get an
    // explicit case; everything else falls to kernel-class dispatch. File sinks
    // are gated DECLARATIVELY: any tool opening a caller path declares it in
    // TOOL_PATH_ARGS, and every declared arg runs the same evaluateFileAccess
    // gate — covering the raw fs tools AND the structured-document tools
    // (spreadsheet/document/presentation/pdf/ocr/image/search) under ONE
    // boundary, closing the bypass where office tools (classed "internal")
    // reached the filesystem without ever hitting the file-access mode.
    const pathArgs = TOOL_PATH_ARGS[toolName];
    if (toolName === "browser") {
      decision = this.evaluateBrowser(args);
    } else if (pathArgs) {
      decision = this.evaluatePathArgs(pathArgs, args, ctx);
    } else if (toolName === "bash") {
      const command = String(args.command || "");
      // 1) command-shape vetting (denylist / obfuscation / metachars), then
      // 2) confine bash to the file-access mode — the same boundary the file
      //    tools obey — so "workspace only" means bash too. Best-effort on
      //    Windows (parses the command); the planned POSIX path adds a kernel
      //    hard-wall. Both steps live in the shared evaluateShellCommandAndPaths
      //    helper so the shell-class path (process_start) gets the identical
      //    confinement. See shell-path-guard.ts.
      decision = evaluateShellCommandAndPaths(command, {
        workspace: this.workspace,
        fileAccessMode: this.fileAccessMode,
        inlineEvalPolicy: this.inlineEvalPolicy,
        // EFFECTIVE confinement of the spawn this decision gates: bash wraps
        // its spawn via wrapSpawnForSandbox, so .confined (which folds in
        // fallback — a guarded selection that fell back to host reports
        // false) is exactly what will hold at execution time. Read fresh per
        // call so a runtime mode change takes effect without a restart.
        sandboxConfined: getSandboxStatus().confined,
        allowedPathCheck: (rp, sid) => this.isInAllowedPaths(rp, sid),
        sessionId: ctx.sessionId,
      });
    } else if (toolName === "web_fetch" || toolName === "http_request") {
      // manualRuntimeHostPorts() is read fresh per call (like the connect-time
      // re-check path) so a Settings add/remove takes effect without a restart.
      decision = evaluateWebFetch(
        this.egressAllowlist,
        this.egressAllowlistConfigured,
        String(SecurityLayer._selfPort || "7007"),
        String(args.url || ""),
        this.egressMode,
        this.localServicePorts,
        manualRuntimeHostPorts(),
      );
    } else {
      // kernelClassForTool (not raw TOOL_CLASS_MAP) so dynamic MCP tools resolve
      // to the http class and flow through the http gate (SSRF-checked if they
      // carry a url arg, allowed-internal otherwise) instead of the
      // not-in-registry deny — matching how the ARI kernel classifies them.
      decision = this.evaluateByKernelClass(toolName, kernelClassForTool(toolName), args, ctx);
    }

    return decision;
  }

  /**
   * Gate every declared file-path argument through the file-access mode — the
   * single confinement boundary for ALL file sinks (raw fs tools and structured-
   * document tools alike), so the mode means the same thing whichever tool opens
   * the file. One blocked path blocks the call. No TOCTOU: the tools resolve the
   * raw arg via resolveAgentPath and evaluateFileAccess re-derives the identical
   * absolute path, so the validated path is byte-for-byte the opened path.
   */
  private evaluatePathArgs(
    specs: readonly PathArgSpec[],
    args: Record<string, unknown>,
    ctx: ToolCallContext,
  ): SecurityDecision {
    // Collapsed family tools declare action-conditional specs (forActions).
    // Fail closed: when any conditional spec exists, the call's args.action
    // must appear in some spec's forActions — otherwise an action added to
    // the tool but not to the policy table would open paths ungated.
    let applicable: readonly PathArgSpec[] = specs;
    if (specs.some((s) => s.forActions)) {
      const action = String(args.action ?? "");
      if (!specs.some((s) => s.forActions?.includes(action))) {
        return {
          allowed: false,
          reason: `Blocked: action "${action}" has no declared path gating for this tool — add it to pathArgs in the policy table`,
          userHint: USER_HINTS.policy,
        };
      }
      applicable = specs.filter((s) => !s.forActions || s.forActions.includes(action));
    }
    for (const spec of applicable) {
      const raw = args[spec.arg];
      const paths = spec.json
        ? parseJsonPathArray(raw)
        : typeof raw === "string" && raw.length > 0
          ? [raw]
          : [];
      for (const p of paths) {
        const decision = evaluateFileAccess(
          this.workspace,
          this.fileAccessMode,
          (rp, sid) => this.isInAllowedPaths(rp, sid),
          spec.action,
          p,
          ctx.sessionId,
        );
        if (!decision.allowed) return decision;
      }
    }
    return { allowed: true, reason: "File access allowed" };
  }

  // Browser navigate/new_tab egress pre-flight (incl. the urls[] deny-wins
  // batch) — pure logic in ./browser-egress-eval.ts; layer supplies egress state.
  private evaluateBrowser(args: Record<string, unknown>): SecurityDecision {
    return evaluateBrowserAction(args, {
      egressAllowlist: this.egressAllowlist,
      egressAllowlistConfigured: this.egressAllowlistConfigured,
      selfPort: String(SecurityLayer._selfPort || "7007"),
      egressMode: this.egressMode,
      localServicePorts: this.localServicePorts,
      manualHostPorts: manualRuntimeHostPorts(),
    });
  }

  /**
   * Class-based dispatch for tools that aren't routed by their explicit
   * named case above. Delegates to the pure evaluateByKernelClass policy
   * function in ./kernel-class-policy.ts, supplying the layer's runtime
   * state as a policy context.
   */
  private evaluateByKernelClass(
    toolName: string,
    kernelClass: KernelClass | undefined,
    args: Record<string, unknown>,
    ctx: ToolCallContext,
  ): SecurityDecision {
    return evaluateKernelClassPolicy(toolName, kernelClass, args, ctx, {
      egressAllowlist: this.egressAllowlist,
      egressAllowlistConfigured: this.egressAllowlistConfigured,
      egressMode: this.egressMode,
      selfPort: String(SecurityLayer._selfPort || "7007"),
      localServicePorts: this.localServicePorts,
      manualHostPorts: manualRuntimeHostPorts(),
      workspace: this.workspace,
      fileAccessMode: this.fileAccessMode,
      inlineEvalPolicy: this.inlineEvalPolicy,
      isInAllowedPaths: (rp, sid) => this.isInAllowedPaths(rp, sid),
    });
  }

  /**
   * Async SSRF check with DNS pinning.
   * Resolves hostname to IP and validates the resolved address.
   * Call this for actual network requests (not just policy check).
   */
  async validateUrlWithDns(url: string): Promise<SecurityDecision> {
    return validateUrlWithDns(
      this.egressAllowlist,
      this.egressAllowlistConfigured,
      String(SecurityLayer._selfPort || "7007"),
      url,
      this.egressMode,
      this.localServicePorts,
      manualRuntimeHostPorts(),
    );
  }
}

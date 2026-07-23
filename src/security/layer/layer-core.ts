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
import { TOOL_PATH_ARGS, hasCapability, type KernelClass, type PathArgSpec } from "../../tool-registry.js";
import { sessionWorkRootOf } from "../../workspace/paths.js";
import { evaluateByKernelClass as evaluateKernelClassPolicy } from "./kernel-class-policy.js";
import { loadEgressMode, loadLocalServicePorts, loadFileAccessMode, loadInlineEvalPolicy, manualRuntimeHostPorts } from "./security-config.js";
import { fingerprintSecurityPolicy, parseJsonPathArray, restoreSecurityAllowedPaths, snapshotSecurityRuntime, type SecurityRuntimeIdentity } from "./runtime-state.js";

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
    // Load egress allowlist from ~/.lax/egress-allowlist.json.
    //
    // In permissive mode (default): allowlist is the "trusted destinations"
    // list — hosts the agent may send secret-shaped payloads to. Hosts not
    // listed are still reachable for plain surfing; only secret-bearing
    // POST/PUT/PATCH/DELETE bodies are gated (enforced at the tool layer).
    //
    // In strict mode: allowlist is the only set of hosts the agent may
    // reach at all. Missing file in strict mode → deny-with-hint.
    try {
      const allowlistPath = join(getLaxDir(), "egress-allowlist.json");
      if (existsSync(allowlistPath)) {
        const parsed = JSON.parse(readFileSync(allowlistPath, "utf-8"));
        if (Array.isArray(parsed)) {
          this.egressAllowlist = new Set(parsed.map((d: unknown) => String(d).toLowerCase()));
          this.egressAllowlistConfigured = true;
          logger.info(`[security] Egress allowlist loaded: ${this.egressAllowlist.size} domains (mode=${this.egressMode})`);
        } else {
          logger.warn(`[security] ${allowlistPath} is not a JSON array — treating as missing`);
        }
      } else if (this.egressMode === "strict") {
        logger.warn(
          `[security] strict mode but no allowlist at ${allowlistPath} — all outbound requests will be denied. ` +
          `Create the file with a JSON array of allowed domains or set egressMode to "permissive" in ~/.lax/security.json.`,
        );
      }
    } catch (e) {
      logger.warn(`[security] Failed to load egress allowlist: ${(e as Error).message}`);
    }
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

    // Delegated agents using write/edit/bash must have worktree isolation
    // IF they're modifying repo SOURCE code. Writes to user-content
    // territory (workspace/, ~/Documents, ~/Desktop, anywhere outside the
    // repo) don't need isolation — the sandbox protects the agent's own running
    // code from mid-task mutation, NOT the workers producing user-facing
    // artifacts. The old blanket rule killed every content-creation worker where
    // worktree provisioning wasn't wired up (the polish-the-pptx case).
    //
    // For shell tools the requirement is STRICTER (see the shell branch below):
    // worktree isolation is not enough — a self-verify shell also needs effective
    // OS containment, because a shell's children / redirects / expansions escape
    // the worktree that write/edit's explicit `path` arg keeps them inside.
    if (callCtx === "delegated" && WORKTREE_REQUIRED_TOOLS.has(toolName)) {
      const sessionKey = ctx.sessionId;
      const hasWorktree = this.hasSessionWorktree(sessionKey);
      if (hasCapability(toolName, "shell")) {
        // ── Delegated-shell containment gate (chunk K) ──
        // A delegated agent MAY run shell to self-verify its own work (build /
        // type-check / test — the aider-polyglot / workflow-subagent case that
        // was blocked for 7 weeks) ONLY when it is DOUBLY contained:
        //   (1) worktree isolation      — its writes can't reach the main agent's
        //                                  live running source, AND
        //   (2) effective OS containment — a confined sandbox (or an acknowledged
        //                                  host / scoped work root; see
        //                                  delegatedShellOsContained), so the
        //                                  shell's children/redirects/expansions
        //                                  are caged, not just its top-level argv.
        // Missing EITHER → block (err safe). cron never reaches here: shell is in
        // CONTEXT_RESTRICTED_TOOLS for cron and was denied above. The command
        // denylist / rm / egress / network-client rules run downstream regardless
        // (evaluateShellCommandAndPaths), so a dangerous command (rm -rf, curl,
        // …) stays blocked even when the agent is fully contained.
        if (!hasWorktree) {
          return {
            allowed: false,
            reason: `Blocked: delegated shell tool "${toolName}" requires worktree isolation to run (no worktree is provisioned for this session)`,
            userHint: USER_HINTS.worktreeIsolation,
          };
        }
        if (!this.delegatedShellOsContained(sessionKey)) {
          return {
            allowed: false,
            reason: `Blocked: delegated shell tool "${toolName}" requires an effectively-confined sandbox — the selected sandbox fell back to the unconfined host and this run has no operator acknowledgement or scoped work root, so a self-verify shell cannot be contained`,
            userHint: USER_HINTS.policy,
          };
        }
        // Contained (worktree + OS containment) → fall through to the shared
        // command-shape / file-access vetting below.
      } else if (!hasWorktree) {
        // Non-shell workspace-write tools (write/edit/ari_file/delete_file):
        // isolation is required only for repo SOURCE paths — user-content writes
        // are exempt (they don't touch the agent's running code).
        //
        // ari_file is a single bridge tool whose action (read|write) lives in
        // args.action — a read never mutates source, and a write to user-content
        // territory is exempt just like write/edit. So gate only ari_file WRITES
        // to source paths, mirroring the write/edit reasoning above.
        const ariFileAction = toolName === "ari_file" ? String(args.action || "read") : null;
        const ariFileExempt = ariFileAction === "read" ||
          (ariFileAction === "write" && this.isUserContentPath(String(args.path || "")));
        // delete_file shares edit's `path` arg + blast radius → a user-content
        // delete skips the worktree too (else all delegated deletes were refused).
        const isContentWrite =
          ((toolName === "write" || toolName === "edit" || toolName === "delete_file") &&
            this.isUserContentPath(String(args.path || ""))) ||
          ariFileExempt;
        if (!isContentWrite) {
          return {
            allowed: false,
            reason: `Blocked: delegated agent "${toolName}" requires worktree isolation for source-code paths (writes to workspace/, ~/Documents, or anywhere outside the repo don't need it)`,
            userHint: USER_HINTS.worktreeIsolation,
          };
        }
      }
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

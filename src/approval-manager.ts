/**
 * Approval Manager — HumanLayer-style pause-and-wait for dangerous tools.
 *
 * Flow:
 *   1. Agent wants to call tool X. Tool executor checks DANGEROUS_TOOLS.
 *   2. If flagged, calls requestApproval() which emits `approval_requested` event
 *      and returns a Promise that resolves when user responds (or times out).
 *   3. UI shows inline card with Approve / Deny / Always allow for this session.
 *   4. Client sends `approval_response` WS message → resolveApproval() fires.
 *   5. Tool runs iff approved; otherwise execute() is skipped with a BLOCKED result.
 *
 * Session-scoped "always allow" cache prevents re-prompting for the same tool
 * within one session. Still re-prompts across sessions (or after server restart).
 */
import { existsSync, readFileSync } from "node:fs";
import { getRuntimeConfig } from "./config.js";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ServerEvent } from "./types.js";

const APPROVAL_TIMEOUT_MS = 5 * 60_000; // 5 min — long enough to read + decide

/**
 * Approval mode — read from settings.json.approvalMode.
 *   "off"       — no approvals, fastest workflow
 *   "sensitive" — default. Gate on truly destructive / externally-visible tools
 *   "strict"    — gate on everything "sensitive" catches PLUS browser control,
 *                 http_request, mission schedule changes. Slower but paranoid.
 */
export type ApprovalMode = "off" | "sensitive" | "strict";

const SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  "bash",           // shell exec, can do anything
  "write",          // creates/overwrites files
  "edit",           // modifies files
  "email_send",     // externally visible, irreversible
  "memory_forget",  // deletes facts
]);

const STRICT_EXTRA: ReadonlySet<string> = new Set([
  "browser",                   // real visible browser control
  "http_request",              // outbound network calls
  "mission_schedule_create",
  "mission_schedule_delete",
  "mission_schedule_update",
]);

/** Back-compat export — the combined strict list. */
export const DANGEROUS_TOOLS: ReadonlySet<string> = new Set([...SENSITIVE_TOOLS, ...STRICT_EXTRA]);

/** Read approval mode from runtime config (~/.lax/config.json). Cached 1s
 *  to avoid disk I/O per call. The settings UI dropdown's POST handler at
 *  routes/settings/preferences.ts persists toolApproval to config.json
 *  (and updates ctx.config in-memory) — reading from getRuntimeConfig keeps
 *  the gate in sync with what the UI saved. Previously this read settings.json
 *  but the UI's POST writes config.json (mirroring how browserMode +
 *  bridgeVoicePreference work), so the enforcement read and the persist
 *  write were on different files and toggling the UI never moved the gate.
 *  Live failure 2026-05-19: user set approval to Off in Settings; UI
 *  showed Off; approval-manager kept reading settings.json (no value
 *  there) and fell back to "sensitive", still prompted on edit/write.
 */
let _cachedMode: ApprovalMode | null = null;
let _modeCachedAt = 0;
function loadApprovalMode(): ApprovalMode {
  if (_cachedMode && Date.now() - _modeCachedAt < 1000) return _cachedMode;
  let mode: ApprovalMode = "off";
  try {
    const cfg = getRuntimeConfig();
    if (cfg.toolApproval === "auto") mode = "off";
    else if (cfg.toolApproval === "confirm-all") mode = "strict";
    else if (cfg.toolApproval === "confirm-risky") mode = "sensitive";
  } catch {
    // config not initialized yet (very early boot) — also tolerate the
    // legacy settings.json path so we never block tools just because
    // config hasn't loaded yet.
    try {
      const settingsPath = join(homedir(), ".lax", "settings.json");
      if (existsSync(settingsPath)) {
        const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as { approvalMode?: string; toolApproval?: string };
        if (s.approvalMode === "off" || s.approvalMode === "sensitive" || s.approvalMode === "strict") mode = s.approvalMode;
        else if (s.toolApproval === "auto") mode = "off";
        else if (s.toolApproval === "confirm-all") mode = "strict";
        else if (s.toolApproval === "confirm-risky") mode = "sensitive";
      }
    } catch {}
  }
  _cachedMode = mode;
  _modeCachedAt = Date.now();
  return mode;
}

/** Should this tool require approval under the current settings? */
export function toolNeedsApproval(toolName: string): boolean {
  const mode = loadApprovalMode();
  if (mode === "off") return false;
  if (mode === "strict") return SENSITIVE_TOOLS.has(toolName) || STRICT_EXTRA.has(toolName);
  // default: sensitive
  return SENSITIVE_TOOLS.has(toolName);
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  toolName: string;
}

class ApprovalManager {
  private pending = new Map<string, PendingApproval>();
  // session → Set of tool names auto-approved for this session
  private sessionAutoApprove = new Map<string, Set<string>>();
  private nextId = 1;

  /**
   * Request approval. Returns a promise that resolves to true (approved) or false (denied/timeout).
   * If session has already auto-approved this tool, resolves immediately.
   */
  async requestApproval(opts: {
    toolName: string;
    toolCallId: string;
    sessionId: string;
    context: string;
    args: Record<string, unknown>;
    emit: (event: ServerEvent) => void;
  }): Promise<boolean> {
    // Session-scoped auto-approval short-circuit
    const auto = this.sessionAutoApprove.get(opts.sessionId);
    if (auto?.has(opts.toolName)) return true;

    const id = `apr-${this.nextId++}-${Date.now()}`;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          opts.emit({ type: "approval_timeout", approvalId: id, toolName: opts.toolName, toolCallId: opts.toolCallId });
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(id, { resolve, timer, sessionId: opts.sessionId, toolName: opts.toolName });

      opts.emit({
        type: "approval_requested",
        approvalId: id,
        toolName: opts.toolName,
        toolCallId: opts.toolCallId,
        context: opts.context,
        argsPreview: JSON.stringify(opts.args).slice(0, 500),
      });
    });
  }

  /** Called when user clicks Approve / Deny / Always allow in UI. */
  resolveApproval(id: string, approved: boolean, rememberForSession = false): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);

    if (approved && rememberForSession) {
      let auto = this.sessionAutoApprove.get(p.sessionId);
      if (!auto) { auto = new Set(); this.sessionAutoApprove.set(p.sessionId, auto); }
      auto.add(p.toolName);
    }

    p.resolve(approved);
    return true;
  }

  /** Clear auto-approvals for a session (e.g. session ended). */
  clearSession(sessionId: string): void {
    this.sessionAutoApprove.delete(sessionId);
    // Deny any still-pending approvals for this session
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        clearTimeout(p.timer);
        p.resolve(false);
        this.pending.delete(id);
      }
    }
  }

  /** List pending approvals (for diagnostics / stale cleanup). */
  pendingCount(): number { return this.pending.size; }
}

let instance: ApprovalManager | null = null;
export function getApprovalManager(): ApprovalManager {
  if (!instance) instance = new ApprovalManager();
  return instance;
}

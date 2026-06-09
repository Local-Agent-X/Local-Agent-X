/**
 * Approval Manager — pause-and-wait gate for tool calls that need user
 * consent. Thin adapter on top of src/autonomy/profiles.ts:
 *
 *   getToolDecision(tool) =
 *     decide(getProfile(loadProfileName()), classifyToolRisk(tool))
 *
 * Callers branch on the four-valued Decision instead of a boolean:
 *   - "allow"               → run, no prompt
 *   - "allow-with-rollback" → run (rollback layer wraps separately; not
 *                             yet wired — treat as allow for now)
 *   - "ask"                 → emit approval_requested, wait for user
 *   - "deny"                → block without prompting
 *
 * Session-scoped "always allow" cache prevents re-prompting for the same
 * (tool, argsFingerprint) within one session. Fingerprint captures the
 * risk-relevant arg (full command for shell, parent dir for write, hostname
 * for network, action for browser) so a grant doesn't accidentally cover
 * unrelated calls. Still re-prompts across sessions.
 *
 * The decision/fingerprint/destructive logic lives in ./approval-decision.ts
 * and the typed action-preview factories in ./approval-preview.ts; both are
 * re-exported here so the original import path is unchanged.
 */

import type { ActionPreview, ServerEvent } from "./types.js";
import { cacheKey, exactKey, DECLINE_SUPPRESS_MS } from "./approval-decision.js";

export {
  getToolDecision,
  decisionRequiresPrompt,
  decisionDenies,
  computeArgsFingerprint,
  isDestructiveCommand,
  requiresIrreversibleConfirm,
} from "./approval-decision.js";

export {
  previewFileEdit,
  previewShellCommand,
  previewNetworkWrite,
  previewMoney,
} from "./approval-preview.js";

const APPROVAL_TIMEOUT_MS = 5 * 60_000; // 5 min — long enough to read + decide

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  alwaysAsk: boolean;
}

class ApprovalManager {
  private pending = new Map<string, PendingApproval>();
  // session → Set of tool names auto-approved for this session
  private sessionAutoApprove = new Map<string, Set<string>>();
  // exactKey → the in-flight approval promise, so a duplicate identical call
  // (e.g. the model emitting delete_file(x) twice in one parallel turn) shares
  // ONE card instead of stacking a second.
  private inflight = new Map<string, Promise<boolean>>();
  // exactKey → timestamp of the last decline/timeout. A re-issue of the same
  // call is auto-declined without a new card until the entry is cleared (next
  // user turn) or ages past DECLINE_SUPPRESS_MS.
  private declined = new Map<string, number>();
  private nextId = 1;

  private gcDeclined(now: number): void {
    for (const [k, ts] of this.declined) {
      if (now - ts > DECLINE_SUPPRESS_MS) this.declined.delete(k);
    }
  }

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
    /** Optional structured preview for the UI to render a typed approval
     *  card (diff, command box, money receipt). Falls back to `argsPreview`
     *  JSON when omitted. */
    preview?: ActionPreview;
    /** Force a prompt every time: skip the session auto-approve cache on both
     *  read and write. Used for irreversible/destructive operations. */
    alwaysAsk?: boolean;
    emit: (event: ServerEvent) => void;
  }): Promise<boolean> {
    // Session-scoped auto-approval short-circuit. Key is composite
    // (toolName, argsFingerprint) so a prior grant for one binary/host/dir
    // does not cover unrelated calls under the same tool. Destructive ops
    // (alwaysAsk) never short-circuit.
    if (!opts.alwaysAsk) {
      const auto = this.sessionAutoApprove.get(opts.sessionId);
      if (auto?.has(cacheKey(opts.toolName, opts.args))) return true;
    }

    // Decline suppression + in-flight coalescing, keyed on EXACT args. Stops
    // the runaway where a declined/timed-out destructive call (delete_file)
    // gets re-issued every model round, spawning a fresh card each time and
    // keeping the turn alive (so "STREAMING" never clears). A re-issue of an
    // identical, recently-declined call is auto-declined silently; an
    // identical call already awaiting a decision rides the same card.
    const ekey = exactKey(opts.sessionId, opts.toolName, opts.args);
    const now = Date.now();
    this.gcDeclined(now);
    const declinedAt = this.declined.get(ekey);
    if (declinedAt !== undefined && now - declinedAt < DECLINE_SUPPRESS_MS) {
      return false;
    }
    const existing = this.inflight.get(ekey);
    if (existing) return existing;

    const id = `apr-${this.nextId++}-${Date.now()}`;

    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          opts.emit({ type: "approval_timeout", approvalId: id, toolName: opts.toolName, toolCallId: opts.toolCallId });
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(id, { resolve, timer, sessionId: opts.sessionId, toolName: opts.toolName, args: opts.args, alwaysAsk: !!opts.alwaysAsk });

      opts.emit({
        type: "approval_requested",
        approvalId: id,
        toolName: opts.toolName,
        toolCallId: opts.toolCallId,
        context: opts.context,
        argsPreview: JSON.stringify(opts.args).slice(0, 500),
        preview: opts.preview,
      });
    });

    this.inflight.set(ekey, promise);
    void promise.then((approved) => {
      this.inflight.delete(ekey);
      if (!approved) this.declined.set(ekey, Date.now());
      else this.declined.delete(ekey);
    });
    return promise;
  }

  /** Clear decline-suppression for a session. Called at each user-turn start
   *  so a deliberate re-request after the model gave up still prompts. */
  clearDeclines(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const k of this.declined.keys()) {
      if (k.startsWith(prefix)) this.declined.delete(k);
    }
  }

  /** Called when user clicks Approve / Deny / Always allow in UI. */
  resolveApproval(id: string, approved: boolean, rememberForSession = false): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);

    // Destructive ops are never remembered — they must re-confirm every time.
    if (approved && rememberForSession && !p.alwaysAsk) {
      let auto = this.sessionAutoApprove.get(p.sessionId);
      if (!auto) { auto = new Set(); this.sessionAutoApprove.set(p.sessionId, auto); }
      auto.add(cacheKey(p.toolName, p.args));
    }

    p.resolve(approved);
    return true;
  }

  /** Clear auto-approvals for a session (e.g. session ended). */
  clearSession(sessionId: string): void {
    this.sessionAutoApprove.delete(sessionId);
    this.clearDeclines(sessionId);
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

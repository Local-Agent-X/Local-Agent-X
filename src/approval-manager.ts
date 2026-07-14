/**
 * Approval Manager — pause-and-wait gate for tool calls that need user
 * consent. Thin adapter on top of src/autonomy/profiles.ts:
 *
 *   getToolDecision(tool) =
 *     decide(getProfile(loadProfileName()), classifyToolRisk(tool))
 *
 * Callers branch on the four-valued Decision instead of a boolean:
 *   - "allow"               → run, no prompt
 *   - "allow-with-rollback" → run, but first snapshot what can be undone
 *                             (tool-execution/capture-rollback.ts phase →
 *                             autonomy/rollback.ts; restore via the
 *                             settings/system rollback route)
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
import { ensureDurableBridge, recordDurableRequest, recordDurableResolve } from "./approval-durable-record.js";

export {
  getToolDecision,
  getRiskDecision,
  decisionRequiresPrompt,
  decisionDenies,
  applyIrreversibleFloor,
  computeArgsFingerprint,
  isDestructiveCommand,
  destructiveOperationReason,
} from "./approval-decision.js";

export {
  previewFileEdit,
  previewShellCommand,
  previewNetworkWrite,
  previewMoney,
} from "./approval-preview.js";

const APPROVAL_TIMEOUT_MS = 5 * 60_000; // 5 min — long enough to read + decide

/**
 * WHY a denial carries a reason: `requestApproval` resolves false on three
 * different paths, and they demand different model behavior —
 *   declined   — the user clicked Deny (or a recent decline is being
 *                re-applied by suppression). A human said no to THIS call.
 *   timeout    — nobody answered before the deadline (or the session tore
 *                down with the card still pending), including a suppressed
 *                re-issue of a call that recently timed out. Absent human ≠
 *                human said no — the model must not report "declined by user".
 *   superseded — the user replied in chat instead of clicking
 *                (denyPendingForSession). The model should read the message;
 *                it may legitimately re-raise the request afterwards.
 *                Superseded NEVER seeds the suppression map — a fresh card
 *                after re-reading the reply is the designed flow.
 */
export type ApprovalDenyReason = "declined" | "timeout" | "superseded";

export interface ApprovalOutcome {
  approved: boolean;
  /** Unique canonical approval resolution. Consumers may bind one-shot work to it. */
  grantId?: string;
  /** Set on every approved:false resolution. */
  reason?: ApprovalDenyReason;
}

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  alwaysAsk: boolean;
  /** Canonical op this card blocks, when the caller is op-scoped. Keys the
   *  durable pendingApproval column + canonical events. */
  opId?: string;
  emit: (event: ServerEvent) => void;
}

class ApprovalManager {
  private pending = new Map<string, PendingApproval>();
  // session → Set of tool names auto-approved for this session
  private sessionAutoApprove = new Map<string, Set<string>>();
  // exactKey → the in-flight approval promise, so a duplicate identical call
  // (e.g. the model emitting delete_file(x) twice in one parallel turn) shares
  // ONE card instead of stacking a second.
  private inflight = new Map<string, Promise<ApprovalOutcome>>();
  // exactKey → last decline/timeout, WITH the reason it happened. A re-issue
  // of the same call is auto-denied without a new card until the entry is
  // cleared (next user turn) or ages past DECLINE_SUPPRESS_MS — and the
  // short-circuit replays the STORED reason, so a re-issue after a timeout
  // reports "timeout", never a fabricated "declined by user". Entries are
  // written SYNCHRONOUSLY at each resolve site (not in a promise .then):
  // a microtask write could land after clearSession's sweep and leak a
  // 60s suppression into a successor session sharing the exactKey (the
  // sessionId||"default" fallback makes that collision real).
  // Seeded ONLY by: Deny click ("declined") and the card timeout
  // ("timeout"); the suppression short-circuit replays stored entries but
  // never writes. denyPendingForSession ("superseded") and clearSession
  // teardown deliberately never seed it.
  private suppressed = new Map<string, { ts: number; reason: ApprovalDenyReason }>();
  private nextId = 1;

  /**
   * Durable settle bookkeeping for op-scoped cards: clears the op's
   * pendingApproval column and appends the approval_resolved canonical event
   * (approval-durable-record.ts — best-effort, warns instead of throwing, so
   * durable bookkeeping never blocks settling the card's promise). No-op for
   * non-op cards. The bridge was awaited before an op-scoped card could be
   * registered, so the sync call is safe here.
   */
  private recordDurableResolve(p: PendingApproval, id: string, approved: boolean, reason?: ApprovalDenyReason): void {
    if (!p.opId) return;
    recordDurableResolve(p.opId, id, p.toolName, approved, reason);
  }

  private gcSuppressed(now: number): void {
    for (const [k, v] of this.suppressed) {
      if (now - v.ts > DECLINE_SUPPRESS_MS) this.suppressed.delete(k);
    }
  }

  /**
   * Request approval. Returns a promise that resolves to true (approved) or false (denied/timeout).
   * If session has already auto-approved this tool, resolves immediately.
   * Boolean adapter over `requestApprovalDetailed` — kept because most call
   * sites (plan-tools, pre-dispatch) only need the yes/no; callers that must
   * distinguish WHY a request failed (user decline vs timeout vs superseded)
   * use the detailed variant.
   */
  async requestApproval(opts: Parameters<ApprovalManager["requestApprovalDetailed"]>[0]): Promise<boolean> {
    return (await this.requestApprovalDetailed(opts)).approved;
  }

  /**
   * Request approval and learn WHY it was denied (see ApprovalDenyReason).
   */
  async requestApprovalDetailed(opts: {
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
    /** Canonical op id when the tool call runs on the canonical path. Enables
     *  the durable pendingApproval column + approval_requested/resolved
     *  canonical events. Optional: non-op callers keep in-process-only cards. */
    opId?: string;
    emit: (event: ServerEvent) => void;
  }): Promise<ApprovalOutcome> {
    // Session-scoped auto-approval short-circuit. Key is composite
    // (toolName, argsFingerprint) so a prior grant for one binary/host/dir
    // does not cover unrelated calls under the same tool. Destructive ops
    // (alwaysAsk) never short-circuit.
    if (!opts.alwaysAsk) {
      const auto = this.sessionAutoApprove.get(opts.sessionId);
      if (auto?.has(cacheKey(opts.toolName, opts.args))) return { approved: true };
    }

    // Decline suppression + in-flight coalescing, keyed on EXACT args. Stops
    // the runaway where a declined/timed-out destructive call (delete_file)
    // gets re-issued every model round, spawning a fresh card each time and
    // keeping the turn alive (so "STREAMING" never clears). A re-issue of an
    // identical, recently-declined call is auto-declined silently; an
    // identical call already awaiting a decision rides the same card.
    const ekey = exactKey(opts.sessionId, opts.toolName, opts.args);
    const now = Date.now();
    this.gcSuppressed(now);
    const hit = this.suppressed.get(ekey);
    if (hit !== undefined && now - hit.ts < DECLINE_SUPPRESS_MS) {
      // Replay the STORED reason: a re-issue after a Deny click is still a
      // human "no", but a re-issue after a timeout is still "nobody answered".
      return { approved: false, reason: hit.reason };
    }
    const existing = this.inflight.get(ekey);
    if (existing) return existing;

    const id = `apr-${this.nextId++}-${Date.now()}`;
    const argsPreview = JSON.stringify(opts.args).slice(0, 500);
    // Load the durable bridge BEFORE registering the card: every settle path
    // (approve/deny/timeout/superseded/teardown) is synchronous, and this
    // await lets them record durably without one. Best-effort: a failed load
    // resolves (never rejects) and the ask proceeds without a durable shadow.
    if (opts.opId) await ensureDurableBridge();

    const promise = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (p && this.pending.delete(id)) {
          this.suppressed.set(ekey, { ts: Date.now(), reason: "timeout" });
          this.recordDurableResolve(p, id, false, "timeout");
          opts.emit({ type: "approval_timeout", approvalId: id, toolName: opts.toolName, toolCallId: opts.toolCallId });
          resolve({ approved: false, reason: "timeout" });
        }
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(id, { resolve, timer, sessionId: opts.sessionId, toolName: opts.toolName, args: opts.args, alwaysAsk: !!opts.alwaysAsk, opId: opts.opId, emit: opts.emit });

      opts.emit({
        type: "approval_requested",
        approvalId: id,
        toolName: opts.toolName,
        toolCallId: opts.toolCallId,
        context: opts.context,
        argsPreview,
        preview: opts.preview,
      });

      // Durable shadow for op-scoped asks: pendingApproval signal column +
      // approval_requested canonical event. Best-effort (warns, never throws)
      // — a durable-record failure must never take down the live card.
      if (opts.opId) {
        recordDurableRequest(opts.opId, {
          approvalId: id,
          toolName: opts.toolName,
          toolCallId: opts.toolCallId,
          argsPreview,
          context: opts.context,
          requestedAt: Date.now(),
        });
      }
    });

    this.inflight.set(ekey, promise);
    // Suppression is written synchronously at each resolve site; this hook
    // only releases the coalescing slot.
    void promise.then(() => this.inflight.delete(ekey));
    return promise;
  }

  /**
   * A new USER MESSAGE arrived while cards were pending — the user chose to
   * answer in words instead of clicking, so every pending card for the
   * session resolves as DENIED and the model reads the message. Deliberately
   * never seeds the suppression map: after reading the reply the model may
   * re-raise the same request and must get a fresh card. (It also CLEARS any
   * existing suppression for the key, preserving the pre-reason behavior
   * where a words-answer reset the gate.)
   * Returns how many cards were denied.
   */
  denyPendingForSession(sessionId: string): number {
    let denied = 0;
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.suppressed.delete(exactKey(p.sessionId, p.toolName, p.args));
      this.recordDurableResolve(p, id, false, "superseded");
      try {
        p.emit({ type: "approval_resolved", approvalId: id, toolName: p.toolName, approved: false });
      } catch { /* a dead emitter must not block the resolution */ }
      p.resolve({ approved: false, reason: "superseded" });
      denied++;
    }
    return denied;
  }

  /** Clear decline-suppression for a session. Called at each user-turn start
   *  so a deliberate re-request after the model gave up still prompts. */
  clearDeclines(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const k of this.suppressed.keys()) {
      if (k.startsWith(prefix)) this.suppressed.delete(k);
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

    // Tell every renderer the card is settled. Without this the stream store
    // only ever knew pending/timeout, so any re-render during the turn
    // resurrected an already-clicked card as a fresh actionable prompt.
    try {
      p.emit({ type: "approval_resolved", approvalId: id, toolName: p.toolName, approved });
    } catch { /* a dead emitter must not block the resolution */ }

    // A Deny click is the ONE path that means "the user said no to this call".
    // Suppression is written HERE, synchronously, so the stored reason can
    // never be a stale microtask racing a session sweep.
    const ekey = exactKey(p.sessionId, p.toolName, p.args);
    this.recordDurableResolve(p, id, approved, approved ? undefined : "declined");
    if (approved) {
      this.suppressed.delete(ekey);
      p.resolve({ approved: true, grantId: id });
    } else {
      this.suppressed.set(ekey, { ts: Date.now(), reason: "declined" });
      p.resolve({ approved: false, reason: "declined" });
    }
    return true;
  }

  /** Clear auto-approvals for a session (e.g. session ended). */
  clearSession(sessionId: string): void {
    this.sessionAutoApprove.delete(sessionId);
    this.clearDeclines(sessionId);
    // Deny any still-pending approvals for this session. Teardown is
    // timeout-equivalent: the card was never answered — nobody said no.
    // Deliberately does NOT seed suppression: the session is gone, and a
    // leftover entry could shadow a successor session that lands on the
    // same exactKey (the sessionId||"default" fallback).
    for (const [id, p] of this.pending) {
      if (p.sessionId === sessionId) {
        clearTimeout(p.timer);
        this.recordDurableResolve(p, id, false, "timeout");
        p.resolve({ approved: false, reason: "timeout" });
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

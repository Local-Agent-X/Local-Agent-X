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
 * tool within one session. Still re-prompts across sessions.
 */

import { createPatch } from "diff";
import type { ActionPreview, ServerEvent } from "./types.js";
import {
  decide,
  getProfile,
  type Decision,
} from "./autonomy/profiles.js";
import { loadProfileName } from "./autonomy/profile-store.js";
import { classifyToolRisk } from "./autonomy/risk.js";

const APPROVAL_TIMEOUT_MS = 5 * 60_000; // 5 min — long enough to read + decide

// Profile name cached 1s — same shape as the prior approvalMode cache.
// loadProfileName() reads ~/.lax/autonomy-profile.json on miss.
let _cachedProfile: ReturnType<typeof loadProfileName> | null = null;
let _profileCachedAt = 0;
function currentProfileName(): ReturnType<typeof loadProfileName> {
  if (_cachedProfile && Date.now() - _profileCachedAt < 1000) return _cachedProfile;
  _cachedProfile = loadProfileName();
  _profileCachedAt = Date.now();
  return _cachedProfile;
}

/** What does the active profile say about this tool? */
export function getToolDecision(toolName: string): Decision {
  const profile = getProfile(currentProfileName());
  return decide(profile, classifyToolRisk(toolName));
}

/** Does this decision require an interactive user prompt before running? */
export function decisionRequiresPrompt(d: Decision): boolean {
  return d === "ask";
}

/** Does this decision block the tool outright? */
export function decisionDenies(d: Decision): boolean {
  return d === "deny";
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
    /** Optional structured preview for the UI to render a typed approval
     *  card (diff, command box, money receipt). Falls back to `argsPreview`
     *  JSON when omitted. */
    preview?: ActionPreview;
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
        preview: opts.preview,
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

// ---------------------------------------------------------------------------
// Action preview factories — build the typed `preview` field attached to
// `approval_requested` events. Pure data, safe to call without an active
// manager. See ActionPreview in types.ts for the shape contract.
// ---------------------------------------------------------------------------

const PREVIEW_BODY_LIMIT = 500;
const PREVIEW_DIFF_HEAD_LINES = 10;
const PREVIEW_DIFF_TAIL_LINES = 10;

export function previewFileEdit(
  path: string,
  oldContent: string,
  newContent: string,
): Extract<ActionPreview, { kind: "file" }> {
  const safePath = typeof path === "string" && path.length > 0 ? path : "<unknown>";
  const oldStr = typeof oldContent === "string" ? oldContent : "";
  const newStr = typeof newContent === "string" ? newContent : "";

  const patch = createPatch(safePath, oldStr, newStr, "", "", { context: 3 });
  const lines = patch.split("\n");
  const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
  const header = hunkStart < 0 ? "" : lines.slice(0, hunkStart).join("\n");
  const bodyLines = hunkStart < 0 ? lines : lines.slice(hunkStart);

  let added = 0;
  let removed = 0;
  for (const line of bodyLines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }

  let truncated = false;
  let bodyText: string;
  if (bodyLines.length > PREVIEW_DIFF_HEAD_LINES + PREVIEW_DIFF_TAIL_LINES) {
    const head = bodyLines.slice(0, PREVIEW_DIFF_HEAD_LINES);
    const tail = bodyLines.slice(-PREVIEW_DIFF_TAIL_LINES);
    const elided = bodyLines.length - PREVIEW_DIFF_HEAD_LINES - PREVIEW_DIFF_TAIL_LINES;
    bodyText = [...head, `… ${elided} line${elided === 1 ? "" : "s"} elided …`, ...tail].join("\n");
    truncated = true;
  } else {
    bodyText = bodyLines.join("\n");
  }

  return {
    kind: "file",
    path: safePath,
    diff: header ? `${header}\n${bodyText}` : bodyText,
    lineCount: { added, removed },
    truncated,
  };
}

export function previewShellCommand(
  cmd: string,
  cwd: string,
  explanation?: string,
): Extract<ActionPreview, { kind: "shell" }> {
  const out: Extract<ActionPreview, { kind: "shell" }> = {
    kind: "shell",
    cmd: typeof cmd === "string" ? cmd : "",
    cwd: typeof cwd === "string" ? cwd : "",
  };
  if (typeof explanation === "string" && explanation.length > 0) out.explanation = explanation;
  return out;
}

export function previewNetworkWrite(
  method: string,
  url: string,
  body: unknown,
): Extract<ActionPreview, { kind: "network" }> {
  const safeMethod = typeof method === "string" && method.length > 0 ? method.toUpperCase() : "GET";
  const safeUrl = typeof url === "string" ? url : "";

  let bodyStr: string;
  if (body == null) bodyStr = "";
  else if (typeof body === "string") bodyStr = body;
  else {
    try { bodyStr = JSON.stringify(body); }
    catch { bodyStr = String(body); }
  }
  const bodyTruncated = bodyStr.length > PREVIEW_BODY_LIMIT;
  const bodyPreview = bodyTruncated ? `${bodyStr.slice(0, PREVIEW_BODY_LIMIT)}…` : bodyStr;

  let domain = "";
  if (safeUrl) {
    try { domain = new URL(safeUrl).host; }
    catch {
      const m = safeUrl.match(/^(?:https?:\/\/)?([^/?#]+)/i);
      domain = m?.[1] ?? "";
    }
  }

  return { kind: "network", method: safeMethod, url: safeUrl, bodyPreview, bodyTruncated, domain };
}

export function previewMoney(
  amount: number,
  currency: string,
  recipient: string,
  source: string,
): Extract<ActionPreview, { kind: "money" }> {
  const safeAmount = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  const safeCurrency = typeof currency === "string" && currency.length > 0 ? currency.toUpperCase() : "USD";
  const safeRecipient = typeof recipient === "string" ? recipient : "";
  const safeSource = typeof source === "string" ? source : "";

  let formatted: string;
  try {
    formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: safeCurrency }).format(safeAmount);
  } catch {
    formatted = `${safeAmount.toFixed(2)} ${safeCurrency}`;
  }

  return {
    kind: "money",
    amount: safeAmount,
    currency: safeCurrency,
    recipient: safeRecipient,
    source: safeSource,
    formatted,
  };
}

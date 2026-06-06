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
 */

import { createPatch } from "diff";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";
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
  args: Record<string, unknown>;
  alwaysAsk: boolean;
}

/**
 * Compute a stable, risk-relevant fingerprint of a tool call's args. Used to
 * key the session auto-approve cache so a grant for `bash git status` does
 * NOT cover `bash rm -rf /`. Must be pure — no Date.now, no randomness, no
 * env reads — so the same input always produces the same key.
 */
export function computeArgsFingerprint(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const tool = toolName.toLowerCase();

  if (tool === "bash" || tool === "shell" || tool === "ari_shell") {
    const raw = typeof args.command === "string" ? args.command : "";
    // Strip leading env-var assignments: `FOO=bar BAZ=qux cmd ...`
    const stripped = raw.replace(/^(\s*\w+=\S+\s+)+/, "").trim();
    // Fingerprint the FULL command (whitespace-normalized), not just the
    // leading binary. Keying on the binary alone collapsed every subcommand of
    // a multi-purpose tool into one grant — approving `git log` would then
    // auto-approve `git push --force` / `git reset --hard` under the same key.
    return stripped.replace(/\s+/g, " ");
  }

  if (tool === "write" || tool === "edit" || tool === "delete_file") {
    const p = typeof args.path === "string" ? args.path : "";
    if (!p) return "<unresolvable>";
    try {
      return pathDirname(pathResolve(p));
    } catch {
      return "<unresolvable>";
    }
  }

  if (tool === "http_request" || tool === "web_fetch") {
    const u = typeof args.url === "string" ? args.url : "";
    if (!u) return "<malformed>";
    try {
      return new URL(u).hostname;
    } catch {
      return "<malformed>";
    }
  }

  if (tool === "browser") {
    return typeof args.action === "string" ? args.action : "";
  }

  return "*";
}

function cacheKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}::${computeArgsFingerprint(toolName, args)}`;
}

// Exact-args key for in-flight coalescing and decline suppression. Unlike
// cacheKey (which uses the COARSE risk fingerprint so an auto-approve grant
// covers a whole dir/host), this keys on the full canonical args — declining
// delete_file(a.json) must NOT suppress the card for delete_file(b.json) in
// the same dir. Keyed per-session so one session's declines never leak to
// another.
function canonicalArgs(args: Record<string, unknown>): string {
  try {
    const keys = Object.keys(args).sort();
    const ordered: Record<string, unknown> = {};
    for (const k of keys) ordered[k] = args[k];
    return JSON.stringify(ordered);
  } catch {
    return "";
  }
}

function exactKey(sessionId: string, toolName: string, args: Record<string, unknown>): string {
  return `${sessionId}::${toolName}::${canonicalArgs(args)}`;
}

// How long a decline/timeout suppresses an IDENTICAL re-issue. The retry
// storm collapses in milliseconds once repeats resolve instantly, so this is
// just a GC backstop for non-chat runs (agent/cron) that don't call
// clearDeclines at a turn boundary. Chat turns reset declines per user turn,
// so a deliberate re-request after the model gives up still prompts.
const DECLINE_SUPPRESS_MS = 60_000;

// Irreversible / hard-to-undo shell operations that must ALWAYS be confirmed,
// regardless of how relaxed the autonomy profile is and without being
// remembered for the session. The profile decides the *default* posture; this
// list is a floor under it for the handful of operations that can destroy work
// or data with no recovery. Patterns stop at the first command separator so a
// later piped/chained token can't smuggle one in unmatched-by-position.
const DESTRUCTIVE_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b[^|;&]*\s(?:--force\b|--force-with-lease\b|-\w*f\w*\b)/i, reason: "git force-push" },
  { pattern: /\bgit\s+push\b[^|;&]*\s(?:--delete\b|:\S)/i, reason: "git delete remote branch" },
  { pattern: /\bgit\s+reset\b[^|;&]*--hard\b/i, reason: "git reset --hard" },
  { pattern: /\bgit\s+clean\b[^|;&]*-\w*f\w*/i, reason: "git clean -f" },
  { pattern: /\bgit\s+branch\b[^|;&]*\s-D\b/i, reason: "git force-delete branch" },
  { pattern: /\bgit\s+filter-branch\b/i, reason: "git history rewrite" },
  { pattern: /\brm\s+-\w*r\w*f\w*\b/i, reason: "rm -rf" },
  { pattern: /\brm\s+-\w*f\w*r\w*\b/i, reason: "rm -fr" },
  { pattern: /\brm\s+-[rf]\b[^|;&]*\s-[rf]\b/i, reason: "rm -r -f" },
  { pattern: /\bdd\b[^|;&]*\sof=\/dev\//i, reason: "dd to a raw device" },
  { pattern: /\bmkfs\b/i, reason: "filesystem format" },
];

/**
 * If a shell tool call is an irreversible/destructive operation, return a short
 * human reason; otherwise null. Used to force an approval prompt that bypasses
 * both the relaxed-profile auto-allow and the remember-for-session cache.
 */
export function isDestructiveCommand(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const tool = toolName.toLowerCase();
  if (tool !== "bash" && tool !== "shell" && tool !== "ari_shell") return null;
  const cmd = typeof args.command === "string" ? args.command : "";
  for (const { pattern, reason } of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (pattern.test(cmd)) return reason;
  }
  return null;
}

/**
 * The irreversibility floor: force an interactive confirm for any operation
 * that can destroy work or data with no recovery, regardless of how relaxed
 * the autonomy profile is. Returns a short human reason, or null.
 *
 * Two sources feed the floor:
 *   1. Shell-text patterns (isDestructiveCommand) — `rm -rf`, `git push
 *      --force`, etc. inside a bash/shell command string.
 *   2. The "destructive" ToolRisk class — non-shell tools whose whole purpose
 *      is an irreversible side effect (delete_file, process_kill,
 *      memory_forget, marketplace_install). Without this, a destructive
 *      non-shell tool auto-allowed under Power/Autonomous with no prompt.
 *
 * Scoped to "destructive" ONLY. money/secrets are deliberately NOT forced:
 * they already resolve to "ask" under every profile except Autonomous, and
 * Autonomous is the user explicitly opting into unattended money/secrets
 * moves — forcing a confirm there would override that deliberate choice.
 */
export function requiresIrreversibleConfirm(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const shellReason = isDestructiveCommand(toolName, args);
  if (shellReason !== null) return shellReason;
  if (classifyToolRisk(toolName) === "destructive") {
    return `destructive tool (${toolName}) — irreversible, confirm before running`;
  }
  return null;
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

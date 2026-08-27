// Decides whether a tool call is committing — non-idempotent and
// user-visible, so re-running it would double-send the email, re-delete the
// file, re-charge the card. Consumers: the op-level "did this op do work?"
// checks (canonical-loop/agent-runner/run.ts, middlewares/open-steps.ts), the
// turn-replacement lock (session/turn-lock.ts) so an arriving turn never kills
// one mid-side-effect, the mid-turn-stale abort brake (the NAME-ONLY layer
// only — see rowCommittedWork below for why), and the loop detectors.
//
// Two layers over one rule set:
//   - isCommittingTool(name)       — name only. Multi-action tools
//     (ARG_AWARE_TOOLS) are too coarse to judge by name and answer false here.
//   - isCommittingCall(name, args) — the accurate verdict. Args exist only at
//     dispatch time, so turn-loop/dispatch-tools.ts asks there and persists the
//     answer on the ToolCallSummary row for the op-level checks to read back.
//   - rowCommittedWork(summaryRow)  — how a PERSISTED row is read back: the
//     recorded verdict when present, the name-only fallback when it is not,
//     and the resultStatus gate that keeps refused work from counting.
//
// Philosophy: be conservative. When in doubt, treat as committing. Missing
// an auto-failover is annoying; double-sending an email is worse.
//
// Single source of truth: tool-registry.ts. Each tool's `risk` decides
// whether it commits. The hand-maintained list this module used to keep
// drifted: agency_create, task_create, issue_create, agent_team_*, and
// most protocol/mission/spreadsheet writers were missing, so the safety
// brake didn't credit them as progress and aborted turns mid-work
// (live demo, 2026-05-27). Deriving from the registry kills that
// drift class — adding a tool to tool-registry.ts is the one and only
// step needed for every downstream consumer.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { TOOLS, type ToolRisk } from "./tool-registry.js";
import { getActivePluginToolMetadata } from "./plugin-system/tool-metadata.js";

/** Risk classes that count as committing for failover + progress checks. */
const COMMITTING_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>([
  "workspace-write",
  "network-write",
  "shell",
  "destructive",
  "money",
  "external-comms",
  "secrets",
]);

/** Tools whose risk classification is too coarse — they need arg-aware
 *  inspection to decide committingness. committingArgReason handles these
 *  properly with method/action checks; at the name-only isCommittingTool
 *  layer we conservatively return false (matches the pre-derivation
 *  behavior). Callers with args available should prefer isCommittingCall. */
const ARG_AWARE_TOOLS: ReadonlySet<string> = new Set<string>([
  "http_request",  // GET/HEAD idempotent; POST/PUT/DELETE/PATCH committing
  "browser",       // click on commit-style buttons is committing
  "pdf",           // read/extract_tables idempotent; create/merge committing
]);

/** pdf actions that only read. Anything else on the tool writes a file. */
const PDF_READONLY_ACTIONS: ReadonlySet<string> = new Set<string>(["read", "extract_tables"]);

/** Committing tools NOT covered by the registry derivation. `tool-registry.ts`
 *  derives risk from the policy taxonomy, but plugin/integration tools register
 *  via tools/plugins.ts and never enter that taxonomy, so their committing
 *  status has to be declared here. Covers secrets, cron, messaging, and the
 *  issue/agent-coordination writes. Without the issue/agent entries a CEO that
 *  actually created issues reads as having committed nothing — tripping the
 *  false-completion guard and denying the mid-turn-stale brake its progress
 *  signal. If one of these later gains a committing-risk tier in the taxonomy,
 *  drop it here. */
const LEGACY_COMMITTING_OVERRIDES: ReadonlySet<string> = new Set<string>([
  "secret_save", "secret_delete",
  "cron_create", "cron_delete", "cron_update",
  "whatsapp_send", "telegram_send",
  "issue_create", "issue_update", "issue_checkout", "issue_release", "agent_wakeup",
  "project_brief_update",
]);

const COMMITTING_HTTP_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

const COMMITTING_BROWSER_ACTION_BUTTONS = /\b(send|submit|pay|confirm|delete|checkout|publish|post|buy|purchase|remove|transfer|sign\s*up|register)\b/i;

interface AssistantMessageWithToolCalls {
  role: "assistant";
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

export interface CommittingFinding {
  toolName: string;
  reason: string;
}

/** The arg-aware verdict for one ARG_AWARE_TOOLS call: the reason it commits,
 *  or null when it does not. UNKNOWN args are treated as committing by the
 *  writers and ignored by browser, exactly as the per-call try/catch used to.
 *
 *  "Unknown" is NOT simply "not an object". Every adapter's parseArgs wraps
 *  JSON it could not parse in `{_raw: "…"}` — a perfectly good record — so a
 *  call whose args never parsed reaches dispatch looking like a defaulted GET.
 *  http_request checks for that below; without it dispatch stamps
 *  `committing: false` on the very call detectCommittingCalls (which sees the
 *  parse failure as `undefined`) calls committing. `pdf` needs no such check:
 *  a record with no `action` already falls through to the committing default. */
function committingArgReason(name: string, args: unknown): string | null {
  const rec = isRecord(args) ? args : null;

  // http_request is idempotent for GET/HEAD but not for POST/PUT/DELETE/PATCH
  if (name === "http_request") {
    if (!rec) return "http_request with unparseable args"; // err on the side of committing
    // parseArgs' failure wrapper, or a record carrying neither field, says
    // nothing about the method — that is unknown, not GET.
    if ("_raw" in rec || (rec.method === undefined && rec.url === undefined)) {
      return "http_request with unparseable args";
    }
    const method = String(rec.method || "GET").toUpperCase();
    if (!COMMITTING_HTTP_METHODS.has(method)) return null;
    return `${method} ${String(rec.url || "").slice(0, 120)}`;
  }

  // pdf reads and table extraction commit nothing; create/merge write a file.
  // Registry risk cannot express this — it is workspace-write because the
  // tool CAN write, which made reading a contract look like doing work.
  if (name === "pdf") {
    const action = rec ? String(rec.action || "") : ""; // unknown → committing
    if (PDF_READONLY_ACTIONS.has(action)) return null;
    return `pdf.${action || "unknown"} writes a file`;
  }

  // browser tool: look for clicks on commit-style buttons
  if (name === "browser") {
    if (!rec) return null;
    const action = String(rec.action || "");
    if (action !== "click" && action !== "click_text" && action !== "act") return null;
    const target = String(rec.text || rec.value || rec.selector || "");
    if (!COMMITTING_BROWSER_ACTION_BUTTONS.test(target)) return null;
    return `browser.${action} on "${target.slice(0, 60)}"`;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The full verdict for ONE call as a reason string (null = not committing).
 *  The single precedence order every arg-aware caller shares, so the two
 *  layers cannot disagree about the same tool.
 *
 *  It MUST match isCommittingTool's order: a plugin registration or a legacy
 *  override DECLARES the tool committing and outranks the arg inspection.
 *  Checking ARG_AWARE_TOOLS first (as this used to) meant a plugin registering
 *  a tool NAMED `browser` / `pdf` / `http_request` got judged by the built-in
 *  tool's arg grammar — args it does not share — so dispatch stamped
 *  `committing: false` on a call the name-only layer calls committing, and that
 *  narrowing persisted on the row forever. Conservative direction wins: a
 *  declaration is a fact about the tool, an arg grammar is a guess about the
 *  call. */
function committingCallReason(name: string, args: unknown): string | null {
  if (getActivePluginToolMetadata(name)) return `${name} is non-idempotent`;
  if (LEGACY_COMMITTING_OVERRIDES.has(name)) return `${name} is non-idempotent`;
  if (ARG_AWARE_TOOLS.has(name)) return committingArgReason(name, args);
  return isCommittingTool(name) ? `${name} is non-idempotent` : null;
}

/** Scan a completed turn's messages for any committing tool calls. */
export function detectCommittingCalls(
  messages: ChatCompletionMessageParam[],
): CommittingFinding[] {
  const findings: CommittingFinding[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const tcs = (m as unknown as AssistantMessageWithToolCalls).tool_calls;
    if (!tcs || !Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      const name = tc.function?.name || "";
      if (!name) continue;

      const reason = committingCallReason(name, parseToolArguments(tc.function?.arguments));
      if (reason) findings.push({ toolName: name, reason });
    }
  }
  return findings;
}

/** Serialized tool arguments → value, or undefined when unparseable. */
function parseToolArguments(raw: string | undefined): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return undefined;
  }
}

/** Convenience: true if ANY committing call was made this turn. */
export function turnPerformedCommittingCall(
  messages: ChatCompletionMessageParam[],
): boolean {
  return detectCommittingCalls(messages).length > 0;
}

/** True if a single tool name is committing. Lets detectors ask "did this
 *  turn commit anything yet?" without re-scanning messages.
 *
 *  Decision order (committingCallReason mirrors it exactly — keep them in step):
 *    1. Active plugin tool metadata (plugin/integration tools are outside the
 *       registry taxonomy; registering one is the declaration).
 *    2. Legacy override Set (for tools not yet in tool-registry).
 *    3. Arg-aware tools (http_request, browser, pdf) return false here —
 *       they need args for an accurate verdict; use isCommittingCall
 *       when args are in scope.
 *    4. Registry-derived: any tool whose `risk` is in COMMITTING_RISKS. */
export function isCommittingTool(name: string): boolean {
  if (getActivePluginToolMetadata(name)) return true;
  if (LEGACY_COMMITTING_OVERRIDES.has(name)) return true;
  if (ARG_AWARE_TOOLS.has(name)) return false;
  const entry = TOOLS[name];
  if (!entry) return false;
  return COMMITTING_RISKS.has(entry.risk);
}

/** True if THIS call commits, args included. The accurate verdict, and the
 *  only one that can tell a `pdf` read from a `pdf create` — same plugin +
 *  override + registry precedence as isCommittingTool (committingCallReason
 *  owns that order), with the arg-aware tools decided by their method/action
 *  instead of conservatively answering false. Callable only where args are in
 *  scope, i.e. dispatch time. */
export function isCommittingCall(tool: string, args: unknown): boolean {
  return committingCallReason(tool, args) !== null;
}

/** Minimal structural view of one stored tool-call summary row — the fields
 *  canonical-loop/types.ts:ToolCallSummary carries that the op-level checks
 *  read. Declared here rather than imported for the same leaf reason as
 *  OpTurnToolRecord below. */
export interface OpTurnToolSummary {
  tool: string;
  resultStatus: string;
  /** The arg-aware verdict dispatch recorded for THIS call (see
   *  isCommittingCall). OPTIONAL and must stay so: every turn written before
   *  the field existed lacks it, so `undefined` means "no verdict on record",
   *  never "did not commit". */
  committing?: boolean;
}

/** Minimal structural view of a stored op turn. Declared here rather than
 *  imported from canonical-loop/types so this module stays a leaf — it is
 *  consumed by session/, agent-guards/ and plugin-system/, none of which
 *  should pull the loop's store types in behind it. */
export interface OpTurnToolRecord {
  toolCallSummary?: OpTurnToolSummary[] | null;
}

/** Tools whose only effect is the agent's OWN task ledger. They are genuinely
 *  committing (a replay would duplicate them) so they stay in isCommittingTool,
 *  but they are not progress on the user's request.
 *
 *  THE one definition. Three separate decisions read it: replay safety
 *  (rowCommittedSubstantiveWork below), the open-steps middleware
 *  (opTouchedTaskLedger), and TERMINATION (canonical-loop/turn-loop/
 *  tool-failure-summary.ts). It was copy-pasted at all three — exactly the
 *  drift class this module's header exists to kill, and worse here because the
 *  three copies gate three different failure directions. Exported rather than
 *  kept private because this module is a leaf: its entire import list is
 *  tool-registry.ts + plugin-system/tool-metadata.ts (plus a type-only openai
 *  import), the same two tool-mutation-check.ts already pulls, so any consumer
 *  of that one takes this with ZERO new transitive dependencies.
 *
 *  HAZARD — an unbounded prefix match, not a registry lookup. An active PLUGIN
 *  tool named `task_*` never enters the policy table (tool-policy/), so it
 *  reads as the agent's own ledger here and would be silently excluded from
 *  substantive-work credit AND from termination. Registry-derived names are
 *  safe today (only the task tools use the prefix); a plugin author picking it
 *  is not, and nothing warns them. */
export function isLedgerTool(name: string): boolean {
  return name.startsWith("task_");
}

/** Did this stored row LAND a committing call?
 *
 *  The ONE place a persisted summary row becomes a committing verdict, so the
 *  two rules that decide it cannot drift apart across readers:
 *
 *   1. `resultStatus` MUST be "ok". `committing` is stamped at dispatch from
 *      the ARGS, before the call runs — a policy-BLOCKED or errored
 *      `pdf create` still carries `committing: true`. Reading the verdict
 *      without this gate is how refused work starts counting as work, which is
 *      why the gate lives HERE and not in each caller.
 *   2. The recorded per-call verdict wins when present; a row written before
 *      the field existed (undefined) falls back to the name-only
 *      isCommittingTool — which answers false for the ARG_AWARE_TOOLS, exactly
 *      as those rows have always been read. Zero rows on disk carry the field
 *      today, so back-compat is the whole behavior for existing history.
 *
 *  This is the REPLAY-SAFETY reader — arg-aware, task_* ledger INCLUDED
 *  (replaying a plan duplicates it). Its live caller is opCommittedWork, the
 *  failover question; session/turn-lock.ts asks the same question at dispatch
 *  time from live args. Use rowCommittedSubstantiveWork for the completion
 *  gates. It is deliberately NOT what mid-turn-stale's abort brake reads: that
 *  site takes the name-only tally because the arg-aware `browser` verdict comes
 *  from a regex over button text, which page content can trip (see
 *  canonical-loop/middlewares/mid-turn-stale.ts for the measurement). */
export function rowCommittedWork(s: OpTurnToolSummary): boolean {
  if (s.resultStatus !== "ok") return false;
  return typeof s.committing === "boolean" ? s.committing : isCommittingTool(s.tool);
}

/** rowCommittedWork minus the agent's own task ledger — the per-row form of
 *  the completion-gate question (see opCommittedSubstantiveWork). */
export function rowCommittedSubstantiveWork(s: OpTurnToolSummary): boolean {
  return !isLedgerTool(s.tool) && rowCommittedWork(s);
}

function opCommittedMatching(
  turns: Iterable<OpTurnToolRecord>,
  landed: (s: OpTurnToolSummary) => boolean,
): boolean {
  for (const turn of turns) {
    for (const s of turn.toolCallSummary ?? []) {
      if (landed(s)) return true;
    }
  }
  return false;
}

/** Did this op commit anything? The failover / substantiation question:
 *  planning counts, because replaying it would duplicate the tasks. */
export function opCommittedWork(turns: Iterable<OpTurnToolRecord>): boolean {
  return opCommittedMatching(turns, rowCommittedWork);
}

/** Did this op commit work on the USER'S request, ignoring its own planning?
 *  The completion-gate question. A gate that forces another turn because steps
 *  are open must not accept the task_create calls that opened those steps as
 *  the evidence that more work is owed — that reasoning is circular, and it is
 *  what made a read-only "summarize these contracts" turn pay a second
 *  round-trip to tick three checkboxes. */
export function opCommittedSubstantiveWork(turns: Iterable<OpTurnToolRecord>): boolean {
  return opCommittedMatching(turns, rowCommittedSubstantiveWork);
}

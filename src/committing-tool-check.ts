// Decides whether a tool call is committing — non-idempotent and
// user-visible, so re-running it would double-send the email, re-delete the
// file, re-charge the card. Consumers: the op-level "did this op do work?"
// checks (canonical-loop/agent-runner/run.ts, middlewares/open-steps.ts), the
// turn-replacement lock (session/turn-lock.ts) so an arriving turn never kills
// one mid-side-effect, the mid-turn-stale abort brake (the NAME-ONLY layer
// only — see rowCommittedWork below for why), and the loop detectors.
//
// Two layers over one rule set:
//   - isCommittingTool(name)       — name only. Multi-action tools (a row's
//     `committing` spec) are too coarse to judge by name and answer false here.
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
import { TOOLS, ariActionOf, committingSpecOf, destinationSpecsOf, pathSpecsForCall, policyRowOf, type ToolRisk } from "./tool-registry.js";
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
  "publish",
]);

// A tool whose risk tier is too coarse declares how its calls are judged on
// its row (`committing`: kernel-write, path-write, commit-button).
// committingArgReason reads that spec; at the name-only isCommittingTool layer
// such a tool conservatively answers false (matches the pre-derivation
// behavior). Callers with args available should prefer isCommittingCall.

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

/** The arg-aware verdict for one call of a tool with a `committing` spec: the
 *  reason it commits, or null when it does not. UNKNOWN args are treated as
 *  committing by the writers and ignored by a commit-button tool, exactly as
 *  the per-call try/catch used to.
 *
 *  "Unknown" is NOT simply "not an object". Every adapter's parseArgs wraps
 *  JSON it could not parse in `{_raw: "…"}` — a perfectly good record — so a
 *  call whose args never parsed reaches dispatch looking like a defaulted GET.
 *  kernel-write checks for that below; without it dispatch stamps
 *  `committing: false` on the very call detectCommittingCalls (which sees the
 *  parse failure as `undefined`) calls committing. path-write needs no such
 *  check: a record with no `action` opens no declared path, which already
 *  falls through to the committing default. */
function committingArgReason(name: string, args: unknown): string | null {
  const rec = isRecord(args) ? args : null;

  switch (committingSpecOf(name)) {
    // The kernel's verb, read off the argument its row names (http_request's
    // method): GET/HEAD idempotent, a write verb committing.
    case "kernel-write": {
      const spec = policyRowOf(name)?.ariAction;
      const verbArg = typeof spec === "object" ? spec.arg : undefined;
      const siteArg = destinationSpecsOf(name, rec ?? {})?.find((d) => d.to === "site");
      const target = siteArg && "arg" in siteArg ? siteArg.arg : undefined;
      // parseArgs' failure wrapper, or a record carrying neither the verb nor
      // the target, says nothing about the verb — that is unknown, not a read.
      if (!rec || "_raw" in rec || (verbArg !== undefined && rec[verbArg] === undefined && (target === undefined || rec[target] === undefined))) {
        return `${name} with unparseable args`;
      }
      const verb = ariActionOf(name, rec);
      if (KERNEL_READ_VERBS.has(verb)) return null;
      return `${verb.toUpperCase()} ${String(target ? rec[target] ?? "" : "").slice(0, 120)}`;
    }
    // The paths its action opens: a call that only reads them commits nothing
    // (pdf read/extract_tables); a write, or an action no spec knows, does.
    // The tier cannot express this — it is workspace-write because the tool
    // CAN write, which made reading a contract look like doing work.
    case "path-write": {
      const specs = pathSpecsForCall(name, rec ?? {});
      if (specs.length > 0 && specs.every((s) => s.action === "read")) return null;
      return `${name}.${String(rec?.action || "") || "unknown"} writes a file`;
    }
    // A click on a commit-shaped control (send, pay, delete…).
    case "commit-button": {
      if (!rec) return null;
      const action = String(rec.action || "");
      if (action !== "click" && action !== "click_text" && action !== "act") return null;
      const target = String(rec.text || rec.value || rec.selector || "");
      if (!COMMITTING_BROWSER_ACTION_BUTTONS.test(target)) return null;
      return `${name}.${action} on "${target.slice(0, 60)}"`;
    }
  }
  return null;
}

/** Kernel verbs that change nothing at the far end. */
const KERNEL_READ_VERBS: ReadonlySet<string> = new Set(["get", "head", "options"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The full verdict for ONE call as a reason string (null = not committing).
 *  The single precedence order every arg-aware caller shares, so the two
 *  layers cannot disagree about the same tool.
 *
 *  It MUST match isCommittingTool's order: a plugin registration DECLARES the
 *  tool committing and outranks the arg inspection.
 *  Checking the arg-aware tools first (as this used to) meant a plugin
 *  registering a tool NAMED `browser` / `pdf` / `http_request` got judged by
 *  the built-in tool's arg grammar — args it does not share — so dispatch stamped
 *  `committing: false` on a call the name-only layer calls committing, and that
 *  narrowing persisted on the row forever. Conservative direction wins: a
 *  declaration is a fact about the tool, an arg grammar is a guess about the
 *  call. */
function committingCallReason(name: string, args: unknown): string | null {
  if (getActivePluginToolMetadata(name)) return `${name} is non-idempotent`;
  if (committingSpecOf(name)) return committingArgReason(name, args);
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
 *    2. A tool with a `committing` spec (http_request, browser, pdf) returns
 *       false here — it needs args for an accurate verdict; use
 *       isCommittingCall when args are in scope.
 *    3. Registry-derived: any tool whose `risk` is in COMMITTING_RISKS. */
export function isCommittingTool(name: string): boolean {
  if (getActivePluginToolMetadata(name)) return true;
  if (committingSpecOf(name)) return false;
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
 *      isCommittingTool — which answers false for the arg-aware tools, exactly
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

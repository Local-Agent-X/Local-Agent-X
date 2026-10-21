// Approvals: a call an unattended run (cron / delegated / api) could not make
// without the user's yes. The run does not pause: the gate parks the call here
// (src/tool-execution/deferred-call.ts) and finishes what it can without it.
// The item waits, with no expiry, until the user answers. Approve runs that
// exact call once, then, through the normal pipeline (the caller supplies the
// runner: src/tool-execution/approved-call.ts behind src/routes/inbox.ts) and
// reports the outcome as a new item; Decline runs nothing and closes it.
//
// What the user approves is what the body shows, so the body names the job,
// the tool, the arguments that say what it does to whom, and why it needed
// them; the call that runs is the stored record, never anything a client sent.

import { createHash } from "node:crypto";
import { redactString } from "../ops/redactor.js";
import { inboxStore, postToInbox } from "./index.js";
import { clip } from "./producers.js";
import type { DeferredCallRecord, InboxAction, InboxItem, InboxLink, InboxResolution, StoredInboxItem } from "./types.js";

export const APPROVAL_ACTIONS: InboxAction[] = [{ id: "approve", label: "Approve" }, { id: "decline", label: "Decline" }];

const ARG_CHARS = 300;
const RESULT_LINES = 8;
const RESULT_CHARS = 600;

// The arguments that say what a call does and to whom, in reading order.
const NAMED_ARGS: ReadonlyArray<readonly [string, string]> = [
  ["command", "Command"], ["path", "Path"], ["paths", "Paths"], ["url", "URL"],
  ["to", "To"], ["cc", "Cc"], ["bcc", "Bcc"], ["recipients", "Recipients"], ["chat_id", "Chat"],
];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function argText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : stableJson(v))).join(", ");
  return stableJson(value);
}

/** One line per argument a person needs to see, then the rest; redacted, clipped. */
export function describeDeferredArgs(args: Record<string, unknown>): string[] {
  const named = new Set(NAMED_ARGS.map(([key]) => key));
  const lines = NAMED_ARGS.filter(([key]) => args[key] !== undefined).map(([key, label]) => `${label}: ${clip(argText(args[key]), ARG_CHARS)}`);
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !named.has(key)));
  if (Object.keys(rest).length > 0) lines.push(`Other arguments: ${clip(stableJson(rest), ARG_CHARS)}`);
  return lines.map((line) => redactString(line).redacted);
}

/** One item per job and exact call: a scheduled job parks the same call on
 *  every run, so its key is the job, not the run. */
function approvalKey(call: DeferredCallRecord): string {
  const fingerprint = createHash("sha256").update(`${call.toolName}\n${stableJson(call.args)}`).digest("hex").slice(0, 16);
  const scope = call.cronJobId ? `cron:${call.cronJobId}` : call.opId ?? call.sessionId ?? call.callContext;
  return `approval:${scope}:${fingerprint}`;
}

function linkOf(call: DeferredCallRecord): InboxLink {
  return { ...(call.sessionId ? { sessionId: call.sessionId } : {}), ...(call.opId ? { opId: call.opId } : {}) };
}

/** What Approve does, in the item's last line: it runs the call once, now,
 *  and for a vault-secret send also remembers each key at its site (the gate
 *  keeps the pair on the user's yes, secret-destination-gate.ts). The item
 *  carries which it is (`grant`); every other approval keeps the plain line. */
function approveSentence(call: DeferredCallRecord): string {
  const pairs = call.grant?.kind === "secret-destination" ? call.grant.pairs : [];
  if (pairs.length === 0) return "Approve runs this exact call once, now. Decline skips it.";
  const remembered = pairs.map((p) => `${p.name} may go to ${p.destination}`).join(", and that ");
  return `Approve runs this exact call once, now, and remembers that ${remembered} (Settings → Secrets lists it). Decline skips it and remembers nothing.`;
}

/** Park a call for the user's yes. Returns the item, or null when the inbox
 *  could not record it (the gate then refuses as it did before parking). */
export function inboxApprovalRequest(call: DeferredCallRecord): InboxItem | null {
  return postToInbox({
    kind: "approval",
    title: `${call.jobLabel} wants to run ${call.toolName}`,
    body: [
      `Tool: ${call.toolName}`,
      ...describeDeferredArgs(call.args),
      "",
      `Why it needs you: ${redactString(clip(call.reason, 600)).redacted}`,
      "",
      approveSentence(call),
    ].join("\n"),
    needsYou: true,
    key: approvalKey(call),
    link: linkOf(call),
    actions: APPROVAL_ACTIONS,
    deferredCall: call,
  });
}

export interface ApprovedCallOutcome {
  /** The tool result's status (ok, error, blocked, declined, timeout, running). */
  status: string;
  /** The result text as the user reads it: no status header, no model guidance. */
  text: string;
}

const OUTCOME_PHRASE: Record<string, string> = {
  ok: "ran", running: "started", blocked: "was blocked", declined: "was declined", timeout: "timed out",
};

function postApprovedResult(item: StoredInboxItem & { deferredCall: DeferredCallRecord }, title: string, detail: string, failed: boolean): InboxItem | null {
  const call = item.deferredCall;
  return postToInbox({
    kind: "job",
    title,
    body: `${call.jobLabel} wanted ${call.toolName}; you approved it.\n\n${redactString(detail).redacted}`,
    needsYou: failed,
    key: `approval-result:${item.id}`,
    link: linkOf(call),
  });
}

export type InboxActResult =
  | { ok: true; resolution: InboxResolution; outcome?: string; resultId?: string; error?: string }
  | { ok: false; refused: "missing" | "not-approval" | "answered" };

/** Why an answer was refused, as the user reads it (the HTTP route's error
 *  body, the phone's error frame). */
export const INBOX_REFUSAL_TEXT: Record<Extract<InboxActResult, { ok: false }>["refused"], string> = {
  missing: "No such inbox item",
  "not-approval": "That item is not waiting for an approval",
  answered: "That approval was already answered",
};

export function declineInboxItem(id: string): InboxActResult {
  const claim = inboxStore().claimApproval(id, "declined");
  return claim.kind === "claimed" ? { ok: true, resolution: "declined" } : { ok: false, refused: claim.kind };
}

export interface ApproveDeps {
  /** Whether a tool by this name can still be dispatched. */
  hasTool: (name: string) => boolean;
  /** Dispatch the stored call once, through every gate, under the user's yes. */
  run: (call: DeferredCallRecord, itemId: string) => Promise<ApprovedCallOutcome>;
  /** Called once the item is answered, before anything runs. */
  onAnswered?: () => void;
}

/**
 * Approve: claim the item (the store's claim is the only guard against a
 * double click, so the call runs at most once), then run it and report.
 */
export async function approveInboxItem(id: string, deps: ApproveDeps): Promise<InboxActResult> {
  const store = inboxStore();
  const pending = store.get(id)?.deferredCall;
  const runnable = pending ? deps.hasTool(pending.toolName) : false;
  const claim = store.claimApproval(id, runnable ? "approved" : "failed");
  if (claim.kind !== "claimed") return { ok: false, refused: claim.kind };
  deps.onAnswered?.();
  const call = claim.item.deferredCall;
  if (!runnable) {
    const error = `There is no tool named "${call.toolName}" any more (it was renamed or removed), so nothing ran.`;
    const posted = postApprovedResult(claim.item, `Your approved ${call.toolName} call could not run`, error, true);
    return { ok: true, resolution: "failed", error, ...(posted ? { resultId: posted.id } : {}) };
  }
  let outcome: ApprovedCallOutcome;
  try {
    outcome = await deps.run(call, id);
  } catch (e) {
    outcome = { status: "error", text: `The call could not be dispatched: ${(e as Error).message}` };
  }
  const detail = outcome.text.split("\n").slice(0, RESULT_LINES).join("\n").slice(0, RESULT_CHARS).trim() || "(no output)";
  const ran = outcome.status === "ok" || outcome.status === "running";
  const posted = postApprovedResult(claim.item, `Your approved ${call.toolName} call ${OUTCOME_PHRASE[outcome.status] ?? "failed"}`, detail, !ran);
  return { ok: true, resolution: "approved", outcome: outcome.status, ...(posted ? { resultId: posted.id } : {}) };
}

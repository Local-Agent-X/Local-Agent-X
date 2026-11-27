/**
 * Asking the build lead (lead-chat.ts) for a decision, and waiting for its
 * answer: what to do with a chunk the review sent back, and the build's other
 * calls (a phase whose scenarios fail, a judge that cannot check the app, the
 * set-aside cap, the finish checks' open items).
 *
 * The engine posts the evidence into the lead's chat, marked as the app's, and
 * waits; the lead answers by calling build_decide (build-decide-tool.ts), which
 * hands the decision back here. A lead that does not answer in time, or has no
 * chat to answer in, is no answer: the caller falls back to the engine's own
 * rules, so a lead can never stall a build. Each decision takes only the
 * answers it lists; build_decide refuses the others, and the lead can answer
 * again in the same turn.
 */
import { randomBytes } from "node:crypto";
import { oweSessionTool, requireSessionTool } from "../../agent-request/prepare-request/session-owed-tools.js";
import { leadChatOf, runLeadTurn, type BuildLeadRef } from "./lead-chat.js";
import { LEAD_ROLE } from "./lead-role.js";
import { FIX_CHUNK_BASE } from "../finish-gates/fix-chunk.js";
import { APP_MESSAGE_LEAD, appAnswerLine } from "../../harness-text.js";

export const LEAD_ACTIONS = ["continue", "fresh", "accept", "narrow", "split", "owed", "overrule", "park"] as const;
export type LeadAction = typeof LEAD_ACTIONS[number];

/** What a chunk the review sent back may be answered with. */
const PUSH_BACK_ACTIONS: readonly LeadAction[] = LEAD_ACTIONS;

export interface LeadDecision {
  action: LeadAction;
  /** Why, in the lead's words: said where the build reports from. */
  reasoning: string;
  /** continue / fresh: what the worker is told to do. */
  instruction?: string;
  /** accept / owed / overrule: what is left, recorded as follow-ups. */
  followUps?: string[];
  /** narrow / split: the chunk's done-when as the lead now holds it. */
  doneWhen?: string;
  /** split: what moves out of the chunk, each a new chunk of the plan. */
  parts?: Array<{ title: string; doneWhen: string }>;
  /** park: the question only the owner can answer. */
  question?: string;
  /** owed: the check only the owner can run, and what it needs. */
  owedCheck?: string;
  /** overrule: what shows the check's finding is wrong (output, file:line). */
  evidence?: string;
  /** The end of a run: the lead's ledger entry for it (orchestrator/lead-ledger.ts). */
  report?: string;
}

export interface LeadSituation {
  chunk: { number: number; title: string; slice: string; doneWhen: string; scenarios: string };
  totalChunks: number;
  /** Fix rounds already spent on this chunk in this run. */
  round: number;
  /** What the review found this time, in full. */
  finding: string;
  /** The worker's own report fields. */
  workerReport: string;
  /** What earlier rounds found and fixed. */
  earlier: string[];
  /** The review found the same thing as the round before. */
  repeated: boolean;
  /** Rounds the chunk may take in all. */
  maxRounds: number;
  /** The budget is spent: a rebuild is no longer on offer, only landing or parking. */
  final?: boolean;
}

/** A decision about the build rather than one chunk's fix round. */
export interface BuildCallSituation {
  kind: "phase-gate" | "wall-probe" | "set-aside-cap" | "finish" | "report";
  /** One line naming the decision, e.g. "Phase 2's scenarios fail on the merged base". */
  title: string;
  /** What the engine found, in full. */
  evidence: string;
  /** The answers this decision takes, each with what the engine then does. */
  answers: Partial<Record<LeadAction, string>>;
  chunkNumber: number;
  totalChunks: number;
}

/** How long the engine waits for the lead before deciding by its own rules. */
export const LEAD_ANSWER_MS = 10 * 60_000;

interface Pending { allowed: readonly LeadAction[]; resolve: (d: LeadDecision) => void; sessionId: string }
const pending = new Map<string, Pending>();

/** build_decide's half: hand a decision to the engine. The reason it was not
 *  taken, or null when it was. */
export function resolveLeadDecision(id: string, decision: LeadDecision): string | null {
  const p = pending.get(id);
  if (!p) return `No build decision is waiting under "${id}": it was answered, timed out, or never asked.`;
  if (!p.allowed.includes(decision.action)) return `Decision ${id} takes one of: ${p.allowed.join(", ")}. Answer again with one of those.`;
  pending.delete(id);
  p.resolve(decision);
  return null;
}

export function isLeadDecisionPending(id: string): boolean {
  return pending.has(id);
}

/** The decisions a chat has been asked and has not answered, by id. */
export function leadDecisionsWaitingOn(sessionId: string): string[] {
  return [...pending].filter(([, p]) => p.sessionId === sessionId).map(([id]) => id);
}

const HEADER = `${APP_MESSAGE_LEAD}: a build decision is waiting.)`;
// Once answered, the lead's view keeps this packet up to its "Decision <id>" line
// and the answer, not the evidence (context-manager/spent-app-requests.ts): the
// lead re-read every answered packet in full on every later decision, 64% of each
// call (label-check-grok, 2026-11-27).
const answerLine = (id: string) => appAnswerLine("build_decide", "decision_id", id, "one call. Then, only if it changes something the owner would want to know, a line for them; then end your turn.");

/** The message that asks the lead about a chunk the review sent back: the role
 *  on the first, then the evidence. Shared with the lead eval
 *  (eval/build-lead), so it is judged on what the lead is actually sent. */
export function leadPacket(id: string, s: LeadSituation, first: boolean): string {
  const c = s.chunk;
  return [
    HEADER,
    ...(first ? ["", LEAD_ROLE] : []),
    "",
    // A finish fix is named by its title alone: the lead repeats what it is
    // told to the owner, and its number is the engine's (fix-chunk.ts).
    `Decision ${id}: ${/^Finish fix \d+:/.test(c.title) ? `"${c.title}"` : `chunk ${c.number}/${s.totalChunks}, "${c.title}"`}, after fix round ${s.round} of at most ${s.maxRounds}.`,
    ...(s.final ? [
      `This is the last decision for this chunk: its rounds are spent. "accept", "owed" and "overrule" land it ` +
      `(the engine still refuses one whose build, tests or held-out scenarios fail); "park" sets it aside with ` +
      `your question; "continue", "fresh", "narrow" and "split" set it aside, and the chunks that depend on it are not built.`,
    ] : []),
    `Slice: ${c.slice || "(none)"}`,
    `Done when: ${c.doneWhen || "(none)"}`,
    `Held-out scenarios it carries: ${c.scenarios || "none"}`,
    "",
    `What the review found${s.repeated ? " (the same as last round)" : ""}:`,
    s.finding,
    "",
    `The worker's report:\n${s.workerReport}`,
    ...(s.earlier.length ? ["", `Found and fixed in earlier rounds:\n${s.earlier.map((f) => `- ${f.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`] : []),
    "",
    answerLine(id),
  ].join("\n");
}

/** The message that asks the lead about one of the build's other calls. */
export function buildCallPacket(id: string, s: BuildCallSituation, first: boolean): string {
  return [
    HEADER,
    ...(first ? ["", LEAD_ROLE] : []),
    "",
    `Decision ${id}: ${s.title} (${s.chunkNumber > FIX_CHUNK_BASE ? "during the finish checks" : `at chunk ${s.chunkNumber}/${s.totalChunks}`}).`,
    "",
    s.evidence,
    "",
    "Answers this decision takes:",
    ...Object.entries(s.answers).map(([action, does]) => `- "${action}": ${does}`),
    "",
    answerLine(id),
  ].join("\n");
}

const firstSent = new Set<string>();

/** Post one decision into the lead's chat and wait; null when there is no lead
 *  or it did not answer in time. */
async function ask(
  ref: BuildLeadRef, allowed: readonly LeadAction[], render: (id: string, first: boolean) => string,
  opts: { answerMs?: number; signal?: AbortSignal },
): Promise<LeadDecision | null> {
  const sessionId = leadChatOf(ref);
  if (!sessionId || opts.signal?.aborted) return null;
  const id = `bd-${randomBytes(4).toString("hex")}`;
  const answered = new Promise<LeadDecision>((resolve) => pending.set(id, { allowed, resolve, sessionId }));
  const first = !firstSent.has(sessionId);
  firstSent.add(sessionId);
  // The packet says "answer with build_decide", so the turn it lands in must
  // have that tool, whatever else selected its tool set.
  const releaseTool = oweSessionTool(sessionId, "build_decide");
  const gaveUp = new Promise<null>((r) => {
    setTimeout(() => r(null), opts.answerMs ?? LEAD_ANSWER_MS);
    opts.signal?.addEventListener("abort", () => r(null), { once: true });
  });
  // A turn that ended without answering is no answer.
  const endedUnanswered = (turn: Promise<unknown>) => turn.then(() => new Promise<typeof UNANSWERED>((r) => setTimeout(() => r(UNANSWERED), 1_000)));
  try {
    const got = await Promise.race([answered, gaveUp, endedUnanswered(runLeadTurn(sessionId, render(id, first)).catch(() => undefined))]);
    if (got !== UNANSWERED || opts.signal?.aborted) return got === UNANSWERED ? null : got;
    // It worked the decision out and ended its turn without the call: asked
    // once more, in a turn that must open with it.
    const releaseRequired = requireSessionTool(sessionId, "build_decide");
    try {
      const again = await Promise.race([answered, gaveUp, endedUnanswered(runLeadTurn(sessionId, answerNow(id)).catch(() => undefined))]);
      return again === UNANSWERED ? null : again;
    } finally {
      releaseRequired();
    }
  } finally {
    pending.delete(id);
    releaseTool();
  }
}

const UNANSWERED = Symbol("the lead's turn ended with no answer");

/** The second ask for a decision the lead's turn left unanswered. */
function answerNow(id: string): string {
  return [
    HEADER,
    "",
    `Decision ${id} is still waiting: your last turn ended without the build_decide call. Give the answer you reached, now.`,
    "",
    answerLine(id),
  ].join("\n");
}

/** Ask the lead about a chunk the review sent back. */
export function askLead(ref: BuildLeadRef, s: LeadSituation, opts: { answerMs?: number; signal?: AbortSignal } = {}): Promise<LeadDecision | null> {
  return ask(ref, PUSH_BACK_ACTIONS, (id, first) => leadPacket(id, s, first), opts);
}

/** Ask the lead one of the build's other calls; only the answers it lists are taken. */
export function askLeadBuildCall(ref: BuildLeadRef, s: BuildCallSituation, opts: { answerMs?: number; signal?: AbortSignal } = {}): Promise<LeadDecision | null> {
  const allowed = LEAD_ACTIONS.filter((a) => a in s.answers);
  return ask(ref, allowed, (id, first) => buildCallPacket(id, s, first), opts);
}

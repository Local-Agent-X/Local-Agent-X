/**
 * Asking the build lead (lead-chat.ts) what to do with a chunk the review sent
 * back, and waiting for its answer.
 *
 * The engine posts the evidence into the lead's chat, marked as the app's, and
 * waits; the lead answers by calling build_decide (build-decide-tool.ts), which
 * hands the decision back here. A lead that does not answer in time, or has no
 * chat to answer in, is no answer: the caller falls back to the engine's own
 * rules, so a lead can never stall a build.
 */
import { randomBytes } from "node:crypto";
import { ensureLeadChat, runLeadTurn, type BuildLeadRef } from "./lead-chat.js";
import { SKEPTIC_BREAK_GROUNDS, SKEPTIC_RULE_REACH } from "../chunk-review/skeptic-bar.js";

export const LEAD_ACTIONS = ["continue", "fresh", "accept", "narrow", "park"] as const;
export type LeadAction = typeof LEAD_ACTIONS[number];

export interface LeadDecision {
  action: LeadAction;
  /** Why, in the lead's words: said where the build reports from. */
  reasoning: string;
  /** continue / fresh: what the worker is told to do. */
  instruction?: string;
  /** accept: what is left, recorded as follow-ups. */
  followUps?: string[];
  /** narrow: the chunk's done-when as the lead now holds it. */
  doneWhen?: string;
  /** park: the question only the owner can answer. */
  question?: string;
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

/** How long the engine waits for the lead before deciding by its own rules. */
export const LEAD_ANSWER_MS = 10 * 60_000;

const pending = new Map<string, (d: LeadDecision) => void>();

/** build_decide's half: hand a decision to the engine. False when nothing waits under `id`. */
export function resolveLeadDecision(id: string, decision: LeadDecision): boolean {
  const resolve = pending.get(id);
  if (!resolve) return false;
  pending.delete(id);
  resolve(decision);
  return true;
}

export function isLeadDecisionPending(id: string): boolean {
  return pending.has(id);
}

/**
 * What the lead is told about its job, at the top of its chat.
 *
 * It judges a finding by the skeptic's own bar (skeptic-bar.ts). Until
 * 2026-11-25 it was told to keep going while rounds closed what they were
 * given: label-check-sol's chunk 3 then spent all eight rounds on a fresh
 * skeptic's next odd input to an unmarked rule (comma forms, trimmed lengths,
 * U+2028), each closed and each followed by another, and was set aside with
 * two chunks behind it. A fresh reviewer every round never runs out of cases.
 */
export const LEAD_ROLE =
  `You lead this build. The engine builds each chunk with a worker and reviews it (the build and tests, a ` +
  `skeptic agent, the held-out scenarios); when the review sends a chunk back, it asks you what to do, and you ` +
  `answer with build_decide. Decide the way the person running the build would.\n\n` +
  `A finding holds the chunk back only when it shows one of: ${SKEPTIC_BREAK_GROUNDS.join("; ")}. ` +
  `${SKEPTIC_RULE_REACH.join(" ")} The skeptic is told the same bar and still stretches it; you hold the line, ` +
  `reading the plan's marks, not the skeptic's.\n\n` +
  `- A real break of what the chunk promised: "continue" (the worker fixes it; say exactly what) or "fresh" ` +
  `(a new worker, when this one is going in circles).\n` +
  `- True but beyond the chunk's job, or a new kind of input to a scoped rule: "accept", with what is left as ` +
  `follow-ups. The build goes on.\n` +
  `- A contract with no edge: "narrow" it to what has been shown, in a done-when the work already meets. ` +
  `Narrowing is for making the contract smaller, never for asking for more.\n` +
  `- Only a choice of product, money, risk or taste the owner must make: "park", with the question.\n\n` +
  `A new reviewer attacks every round and will always find one more odd input. Once what the chunk promised ` +
  `is shown working, another edge case is a follow-up, not another round: each round costs a worker and a ` +
  `review, and chunks that depend on this one wait. A finding that comes back unchanged needs a different move ` +
  `than "continue". The engine will not land a chunk whose build or tests fail, or whose held-out scenarios ` +
  `fail, whatever you decide. Read the code and run the checks yourself when the evidence is unclear.`;

/** The message that asks the lead for one decision: the role on the first, then
 *  the evidence. Shared with the lead eval (eval/build-lead), so it is judged on
 *  what the lead is actually sent. */
export function leadPacket(id: string, s: LeadSituation, first: boolean): string {
  const c = s.chunk;
  return [
    "(Sent by the app, not typed by the user: a build decision is waiting.)",
    ...(first ? ["", LEAD_ROLE] : []),
    "",
    `Decision ${id}: chunk ${c.number}/${s.totalChunks}, "${c.title}", after fix round ${s.round} of at most ${s.maxRounds}.`,
    ...(s.final ? [
      `This is the last decision for this chunk: its rounds are spent. "accept" lands it (the engine still refuses ` +
      `one whose build, tests or held-out scenarios fail); "park" stops for the owner; "continue", "fresh" and ` +
      `"narrow" set the chunk aside, and the chunks that depend on it are not built.`,
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
    `Answer with build_decide(decision_id="${id}", ...). One call, then end your turn.`,
  ].join("\n");
}

/** Ask the lead; null when there is no lead or it did not answer in time. */
export async function askLead(ref: BuildLeadRef, s: LeadSituation, opts: { answerMs?: number; signal?: AbortSignal } = {}): Promise<LeadDecision | null> {
  const sessionId = await ensureLeadChat(ref).catch(() => null);
  if (!sessionId || opts.signal?.aborted) return null;
  const id = `bd-${randomBytes(4).toString("hex")}`;
  const answered = new Promise<LeadDecision>((resolve) => pending.set(id, resolve));
  const first = !firstSent.has(sessionId);
  firstSent.add(sessionId);
  const turn = runLeadTurn(sessionId, leadPacket(id, s, first)).catch(() => undefined);
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), opts.answerMs ?? LEAD_ANSWER_MS));
  const cancelled = new Promise<null>((r) => opts.signal?.addEventListener("abort", () => r(null), { once: true }));
  // A turn that ended without answering is no answer either.
  const unanswered = turn.then(() => new Promise<null>((r) => setTimeout(() => r(null), 1_000)));
  const decision = await Promise.race([answered, timeout, cancelled, unanswered]);
  pending.delete(id);
  return decision;
}
const firstSent = new Set<string>();

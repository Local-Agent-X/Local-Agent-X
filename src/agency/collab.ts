/**
 * A collab (ADR 0007 §9): several models, each in its own chat, on one
 * research question. The chat it was started from takes no part in the
 * research: it starts the member chats, and when they are done it compiles
 * their reports and rules on what they still dispute.
 *
 * The steps, each a turn in every member's chat:
 *   1. research  — the same question to each, alone; a report ending in its
 *                  key claims, one per line, which the app reads
 *   2. challenge — each opens the others' sources and marks every claim
 *                  confirmed, challenged or unverified
 *   3. answer    — each concedes or defends the claims of its own that were
 *                  challenged; then up to two short rounds on what is still
 *                  disputed, between the two sides only
 *
 * Members are ordinary chats, not code sessions: research leans on the parts
 * of the prompt a code session leaves out (context/prompt-mode.ts). Each keeps
 * its own model for the whole collab (session/model-pin.ts); a member whose
 * turn fails is dropped and named, never swapped for another model.
 *
 * Here: the record. What each claim's state is: collab-claims.ts. The messages
 * the app sends: collab-messages.ts. Running the turns: session/collab-run.ts.
 * Starting one: routes/agents/collab.ts.
 */
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createJsonStore } from "../util/json-store.js";
import type { ProviderId } from "../providers/provider-ids.js";

export const COLLAB_MIN_MEMBERS = 2;
export const COLLAB_MAX_MEMBERS = 4;
export const COLLAB_QUESTION_MAX = 4_000;
/** Rounds on what is still disputed after the answers. */
export const COLLAB_DISPUTE_ROUNDS = 2;
/** What one report keeps on the record, by depth. */
export const COLLAB_REPORT_MAX = { standard: 12_000, deep: 24_000 } as const;
const KEPT = 50;

export type CollabState = "running" | "done" | "stopped";
export type CollabDepth = keyof typeof COLLAB_REPORT_MAX;
/** 1 = research only, 2 = research and challenge, 3 = research, challenge and answer. */
export type CollabSteps = 1 | 2 | 3;
export type CollabPhase = "research" | "challenge" | "answer" | "dispute" | "writing";

export interface CollabMember {
  sessionId: string;
  provider: ProviderId;
  /** Empty = the provider's default model. */
  model: string;
  /** What the user and the other members call it. */
  label: string;
  /** Its letter in claim ids: A, B, C, D. */
  letter: string;
  /** Its latest report, cut to the record's limit. */
  report: string;
  /** Its report listed no claims the app could read, so nobody checked it claim by claim. */
  noClaims?: boolean;
  /** Why it left the collab, when it did. */
  dropped?: string;
}

/** Another member's finding on a claim. */
export interface ClaimVerdict {
  /** The letter of the member that gave it. */
  by: string;
  verdict: "confirmed" | "challenged" | "unverified";
  why: string;
  source: string;
  /** A challenge its maker took back. */
  withdrawn?: boolean;
}

/** What the member that made a claim said to a challenge. */
export interface ClaimResponse {
  kind: "conceded" | "defended";
  /** Defended as a matter of weighing, not of fact: more evidence will not settle it. */
  judgment: boolean;
  text: string;
  source: string;
}

export interface Claim {
  /** The member's letter and the claim's number in its report: "A2". */
  id: string;
  owner: string;
  text: string;
  source: string;
  verdicts: ClaimVerdict[];
  response?: ClaimResponse;
}

export interface Collab {
  id: string;
  /** The chat it was started from, which writes the result. */
  hostId: string;
  hostTitle: string;
  question: string;
  steps: CollabSteps;
  depth: CollabDepth;
  phase: CollabPhase;
  /** The round on open disputes being run, 1-based; 0 before any. */
  disputeRound: number;
  state: CollabState;
  /** Why it stopped, or what the result left out. */
  note?: string;
  members: CollabMember[];
  /** Every member's key claims and what became of each. */
  claims: Claim[];
  startedAt: string;
  endedAt?: string;
}

interface CollabFile extends Record<string, unknown> { collabs: Collab[] }

let fileOverride: string | null = null;
function store() {
  return createJsonStore<CollabFile>(fileOverride ?? join(getLaxDir(), "coordination", "collabs.json"), { defaults: () => ({ collabs: [] }) });
}

export function listCollabs(): Collab[] {
  return store().load().collabs;
}

export function getCollab(id: string): Collab | null {
  return listCollabs().find((c) => c.id === id) ?? null;
}

/** Every chat of a collab: the one it started from, then its members. */
export function chatIdsOf(c: Collab): string[] {
  return [c.hostId, ...c.members.map((m) => m.sessionId)];
}

/** The newest collab `sessionId` is part of, as host or member. */
export function collabOfSession(sessionId: string): Collab | null {
  return [...listCollabs()].reverse().find((c) => chatIdsOf(c).includes(sessionId)) ?? null;
}

/** The collab a chat is hosting that has not ended: a chat hosts one at a time. */
export function liveCollabHostedBy(hostId: string): Collab | null {
  return listCollabs().find((c) => c.hostId === hostId && c.state === "running") ?? null;
}

export function saveNewCollab(c: Collab): void {
  store().mutate((draft) => {
    draft.collabs.push(c);
    if (draft.collabs.length > KEPT) draft.collabs.splice(0, draft.collabs.length - KEPT);
  });
}

/** Change one collab's record; returns the record after, or null when it is gone. */
export function updateCollab(id: string, change: (c: Collab) => void): Collab | null {
  return store().mutate((draft) => {
    const c = draft.collabs.find((x) => x.id === id);
    if (!c) return null;
    change(c);
    return structuredClone(c);
  });
}

/** The members still in it. */
export function activeMembers(c: Collab): CollabMember[] {
  return c.members.filter((m) => !m.dropped);
}

export function memberByLetter(c: Collab, letter: string): CollabMember | undefined {
  return c.members.find((m) => m.letter === letter);
}

/** A report cut to `max`: its opening and its end are kept (the summary and
 *  the claims), the middle goes. The whole of it is in the member's chat. */
export function clipReport(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  return `${text.slice(0, head)}\n\n[… the middle of this report was cut by the app; the whole of it is in that model's chat …]\n\n${text.slice(-(max - head))}`;
}

/** Test seam: keep the record in `path` (null = the data dir again). */
export function _setCollabFileForTest(path: string | null): void {
  fileOverride = path;
}

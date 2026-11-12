/**
 * Collabs, for the chat window (ADR 0007 §9, agency/collab.ts).
 *
 *   GET  /api/collab                 every collab on record, newest last
 *   POST /api/collab/start  {sessionId, question, members: [{provider, model}], steps, depth}
 *        The chat `sessionId` becomes the collab's host. One ordinary chat is
 *        made per member, pinned to its model, and the research starts;
 *        nothing is waited for. `steps` is 1 (research only), 2 (and
 *        challenge) or 3 (and answer); `depth` is "standard" or "deep". Refused from a code session: a research collab's
 *        members are chats.
 *   POST /api/collab/stop   {id}
 *
 * Open tabs are told to re-read by a `collab_changed` frame.
 */
import { randomBytes } from "node:crypto";
import type { RouteHandler, ServerContext } from "../../server-context.js";
import { jsonResponse, safeParseBody } from "../../server-utils.js";
import { getRuntimeConfig } from "../../config.js";
import { loadSettings } from "../../settings.js";
import { PROVIDERS } from "../../providers/registry.js";
import { localProviderDecision } from "../../local-only-policy.js";
import { isPinnableSessionId, parseModelPin, sessionModelPins } from "../../session/model-pin.js";
import { sessionModeOf } from "../../session/mode.js";
import { closeIfCutOff, runCollab, setCollabChangedListener, stopCollab } from "../../session/collab-run.js";
import {
  chatIdsOf, getCollab, listCollabs, liveCollabHostedBy, saveNewCollab,
  COLLAB_MAX_MEMBERS, COLLAB_MIN_MEMBERS, COLLAB_QUESTION_MAX, COLLAB_REPORT_MAX,
  type Collab, type CollabDepth, type CollabMember, type CollabSteps,
} from "../../agency/collab.js";
import { openDisputes } from "../../agency/collab-claims.js";
import { startedNote } from "../../agency/collab-messages.js";
import { hasActiveTurn } from "../../session/turn-lock.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("routes.collab");

export interface CollabView {
  id: string;
  hostId: string;
  question: string;
  steps: CollabSteps;
  depth: CollabDepth;
  phase: Collab["phase"];
  disputeRound: number;
  state: Collab["state"];
  note: string;
  /** How many key claims are on record, and how many are still disputed. */
  claims: number;
  disputed: number;
  /** The host chat, then each member's chat: what the tile grid shows together. */
  chatIds: string[];
  members: Array<{ sessionId: string; label: string; provider: string; model: string; reported: boolean; dropped: string }>;
}

export function collabView(c: Collab): CollabView {
  return {
    id: c.id, hostId: c.hostId, question: c.question, steps: c.steps, depth: c.depth, phase: c.phase, disputeRound: c.disputeRound,
    state: c.state, note: c.note ?? "", claims: c.claims.length, disputed: openDisputes(c).length,
    chatIds: chatIdsOf(c),
    members: c.members.map((m) => ({ sessionId: m.sessionId, label: m.label, provider: m.provider, model: m.model, reported: !!m.report, dropped: m.dropped ?? "" })),
  };
}

type Picked = Pick<CollabMember, "provider" | "model" | "label">;

/** The members a start request names, or what is wrong with them. */
export function parseMembers(raw: unknown, usable: (provider: CollabMember["provider"]) => boolean): { members: Picked[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length < COLLAB_MIN_MEMBERS || raw.length > COLLAB_MAX_MEMBERS) {
    return { error: `A collab has ${COLLAB_MIN_MEMBERS} to ${COLLAB_MAX_MEMBERS} models.` };
  }
  const members: Picked[] = [];
  for (const item of raw) {
    const parsed = parseModelPin((item ?? {}) as Record<string, unknown>);
    if ("error" in parsed) return { error: parsed.error };
    const { provider } = parsed.pin;
    const model = parsed.pin.model || PROVIDERS[provider]?.defaultModel || "";
    if (!usable(provider)) return { error: `${PROVIDERS[provider]?.label ?? provider} is not signed in, so it cannot join.` };
    if (members.some((m) => m.provider === provider && m.model === model)) return { error: "Each member must be a different model." };
    members.push({ provider, model, label: model || provider });
  }
  // Two providers serving a model of the same name: say which is which.
  const shared = new Set(members.map((m) => m.label).filter((label, i, all) => all.indexOf(label) !== i));
  for (const m of members) {
    if (shared.has(m.label)) m.label = `${m.label} (${m.provider})`;
  }
  return { members };
}

function short(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

async function broadcastChanged(id: string): Promise<void> {
  try {
    const { broadcastAll } = await import("../../chat-ws/index.js");
    broadcastAll({ type: "collab_changed", id });
  } catch { /* no socket server in tests */ }
}

interface StartRequest {
  hostId: string;
  question: string;
  steps: CollabSteps;
  depth: CollabDepth;
  members: Picked[];
}

/** What a start request asks for, or what is wrong with it. */
function readStart(ctx: ServerContext, body: Record<string, unknown>): StartRequest | { error: string } {
  const hostId = body.sessionId;
  if (!isPinnableSessionId(hostId)) return { error: "sessionId required" };
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return { error: "Say what the collab should research." };
  if (question.length > COLLAB_QUESTION_MAX) return { error: `The question is limited to ${COLLAB_QUESTION_MAX} characters.` };
  const steps = Number(body.steps);
  if (steps !== 1 && steps !== 2 && steps !== 3) return { error: "steps must be 1 (research), 2 (and challenge) or 3 (and answer)." };
  const depth = body.depth;
  if (typeof depth !== "string" || !(depth in COLLAB_REPORT_MAX)) return { error: "depth must be standard or deep." };
  const customBaseUrl = String(loadSettings().customBaseUrl || "");
  const usable = (p: CollabMember["provider"]) =>
    localProviderDecision(p, getRuntimeConfig(), customBaseUrl).allowed
    && PROVIDERS[p].auth.hasCredential({ secretsStore: ctx.secretsStore, configOpenAIKey: ctx.config.openaiApiKey });
  const parsed = parseMembers(body.members, usable);
  if ("error" in parsed) return { error: parsed.error };
  return { hostId, question, steps, depth: depth as CollabDepth, members: parsed.members };
}

async function start(ctx: ServerContext, body: Record<string, unknown>): Promise<{ status: number; data: unknown }> {
  const asked = readStart(ctx, body);
  if ("error" in asked) return { status: 400, data: { error: asked.error } };
  const { hostId, question } = asked;
  const now = Date.now();
  // A chat the user has not written in yet exists only in their browser.
  const host = ctx.sessionStore.load(hostId) ?? { id: hostId, title: short(question, 60), messages: [], createdAt: now, updatedAt: now };
  if (sessionModeOf(host) === "code") return { status: 409, data: { error: "Start a research collab from a chat, not a code session." } };
  if (liveCollabHostedBy(hostId)) return { status: 409, data: { error: "This chat already has a collab running. Stop it first." } };
  // A turn rewrites the whole chat when it ends: rows saved under it would be lost.
  if (hasActiveTurn(hostId)) return { status: 409, data: { error: "This chat is in the middle of a turn. Start the collab when it has finished." } };

  const id = `collab-${randomBytes(6).toString("hex")}`;
  const members: CollabMember[] = [];
  for (const [i, m] of asked.members.entries()) {
    const sessionId = `${id}-m${i + 1}`;
    // Named after its model: the chat list shows it under the chat that started the collab.
    await ctx.saveSession({
      id: sessionId, title: m.label, messages: [], createdAt: now, updatedAt: now,
      startedFrom: hostId, ...(host.projectId ? { projectId: host.projectId } : {}),
    });
    sessionModelPins().set(sessionId, { provider: m.provider, model: m.model });
    members.push({ ...m, sessionId, letter: "ABCD"[i], report: "" });
  }
  const collab: Collab = {
    id, hostId, hostTitle: short(host.title || "this chat", 80), question, steps: asked.steps, depth: asked.depth,
    phase: "research", disputeRound: 0, state: "running", members, claims: [], startedAt: new Date(now).toISOString(),
  };
  // The question was typed on the collab card, not in the chat: put it in the
  // chat it was asked from, with what is now running, so that chat reads as
  // the thread the result will land in.
  host.messages.push({ role: "user", content: question }, { role: "assistant", content: startedNote(collab) });
  host.updatedAt = now;
  await ctx.saveSession(host);
  saveNewCollab(collab);
  setCollabChangedListener((changed) => void broadcastChanged(changed));
  void runCollab(ctx, id).catch((e) => logger.warn(`[collab ${id}] ${(e as Error).message}`));
  await broadcastChanged(id);
  return { status: 200, data: { ok: true, collab: collabView(collab) } };
}

export const handleCollabRoutes: RouteHandler = async (method, url, req, res, ctx) => {
  if (!url.pathname.startsWith("/api/collab")) return false;
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);
  if (method === "GET" && url.pathname === "/api/collab") {
    json(200, { collabs: listCollabs().map((c) => collabView(closeIfCutOff(c))) });
    return true;
  }
  if (method !== "POST") return false;
  const body = await safeParseBody(req);
  if (!body) { json(400, { error: "Invalid JSON" }); return true; }
  if (url.pathname === "/api/collab/start") {
    const out = await start(ctx, body);
    json(out.status, out.data);
    return true;
  }
  if (url.pathname === "/api/collab/stop") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!getCollab(id)) { json(404, { error: "No such collab." }); return true; }
    const after = stopCollab(id);
    await broadcastChanged(id);
    json(200, { ok: true, collab: after ? collabView(after) : null });
    return true;
  }
  return false;
};

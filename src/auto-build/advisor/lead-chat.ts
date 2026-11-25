/**
 * The build lead's chat: one ordinary LAX chat per project build, listed in
 * the sidebar under the chat that started the build, in which the lead decides
 * what the engine does after each chunk.
 *
 * The engine's decisions used to be fixed rules and one-shot advisor calls
 * with no memory of the build: a chunk that closed every finding it was given
 * was set aside after three rounds because the reviewer kept finding new ones,
 * and the whole build stopped behind it (label-check-sol, 2026-11-24). A lead
 * holds the build in one conversation, reads each outcome with what came
 * before, and decides the way the person running a build would: fix, accept
 * with follow-ups, narrow an open-ended contract, or ask the owner.
 *
 * The chat is a chat like any other: the owner can open it, read why the build
 * did what it did, and write in it. The engine's messages in it are marked as
 * the app's. Its id is fixed per project, so a resumed build keeps its lead.
 *
 * A chat needs the server to create it, so the server registers how at boot
 * (server/lifecycle.ts), as it does the linked-chat starter. Without one (tests,
 * a headless run) there is no lead and the engine's own rules decide.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { getChatHandler } from "../../chat-ws/chat-handler.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("auto-build.lead-chat");

export interface LeadChatHost {
  /** Save a new chat started from `originId`, where that chat works (mode, folder, project). */
  create(req: { sessionId: string; originId: string; title: string }): Promise<void>;
  exists(sessionId: string): boolean;
}

let host: LeadChatHost | null = null;
/** The server binds the host to its ServerContext at boot. */
export function setLeadChatHost(h: LeadChatHost | null): void { host = h; }

/** Who leads a build, and from which chat it was started. */
export interface BuildLeadRef {
  projectDir: string;
  /** The chat that started the build: the lead's chat is listed under it. */
  originSessionId: string;
}

/** A build started by a tool with no chat behind it has a synthetic session id. */
export function canHaveLead(originSessionId: string | undefined): originSessionId is string {
  return Boolean(originSessionId) && !originSessionId!.startsWith("orchestrator-");
}

export function leadSessionId(projectDir: string): string {
  return `build-lead-${createHash("sha256").update(projectDir.toLowerCase()).digest("hex").slice(0, 16)}`;
}

/** The lead's chat, created on first use. Null when no host can create it. */
export async function ensureLeadChat(ref: BuildLeadRef): Promise<string | null> {
  if (!host) return null;
  const sessionId = leadSessionId(ref.projectDir);
  if (!host.exists(sessionId)) {
    await host.create({ sessionId, originId: ref.originSessionId, title: `Build lead: ${basename(ref.projectDir)}` });
  }
  return sessionId;
}

/** One message per lead at a time: a chat runs one turn at a time, and parallel
 *  chunks can reach a decision together. */
const queues = new Map<string, Promise<unknown>>();

/** Run one turn of the lead's chat with `message`, after any turn already queued. */
export function runLeadTurn(sessionId: string, message: string): Promise<void> {
  const prior = queues.get(sessionId) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const handler = getChatHandler();
    if (!handler) throw new Error("the chat runner is not up");
    await handler(sessionId, message, [], { channel: "web" });
  });
  queues.set(sessionId, next);
  void next.catch((e) => logger.warn(`[lead] ${sessionId} turn failed: ${(e as Error).message}`)).finally(() => {
    if (queues.get(sessionId) === next) queues.delete(sessionId);
  });
  return next;
}

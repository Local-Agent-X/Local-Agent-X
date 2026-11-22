/**
 * Starting a chat a session_start offer described: the tap makes a new chat
 * linked to the one that offered it, runs its first turn through the same
 * handler a typed message uses, and the starting chat hears how it went.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

const TMP_WS = realpathSync(mkdtempSync(join(tmpdir(), "lax-sessions-start-")));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, workspacePath: (...segs: string[]) => resolve(TMP_WS, ...segs) };
});
vi.mock("../ops/idle-nudge.js", () => ({ scheduleIdleNudge: vi.fn() }));
vi.mock("../inbox/producers.js", () => ({ inboxJobResult: vi.fn() }));

import { handleSessionStart, _resetStartedOffersForTest } from "./sessions-start.js";
import { startLinkedChat } from "../session/start-linked-chat.js";
import { setChatHandler } from "../chat-ws/chat-handler.js";
import { drainPendingNotifications, formatNotificationsForSystemPrompt } from "../ops/pending-notifications.js";
import { scheduleIdleNudge } from "../ops/idle-nudge.js";
import { checkEgressTaint, clearSessionTaint, recordSensitiveRead } from "../data-lineage/taint.js";
import type { ServerContext } from "../server-context.js";
import type { Session } from "../types.js";
import type { Project } from "../agent-store/index.js";

const sessions = new Map<string, Session>();
/** Sessions saved to disk; the rest are only in the server's cache (a chat in its first turn). */
const onDisk = new Set<string>();
const projects: Project[] = [];
const broadcasts: unknown[] = [];
const ctx = {
  sessionStore: { load: (id: string) => (onDisk.has(id) ? sessions.get(id) ?? null : null) },
  getOrCreateSession: (id: string) => sessions.get(id) ?? (() => { const s = { id, title: "New Chat", messages: [], createdAt: 0, updatedAt: 0 } as Session; sessions.set(id, s); return s; })(),
  saveSession: async (s: Session) => { sessions.set(s.id, s); onDisk.add(s.id); },
  flushSession: async () => {},
  broadcastAll: (frame: unknown) => { broadcasts.push(frame); },
  projectStore: {
    list: () => projects,
    findByName: (name: string) => projects.find((p) => p.name === name) ?? null,
    create: (p: Omit<Project, "id">) => { const made = { ...p, id: `proj-${projects.length + 1}` } as Project; projects.push(made); return made; },
  },
} as unknown as ServerContext;

const ran: Array<{ sessionId: string; message: string }> = [];
let turnDone: () => void = () => {};
const settled = () => new Promise<void>((r) => { turnDone = r; });

beforeEach(() => {
  sessions.clear();
  ran.length = 0;
  projects.length = 0;
  broadcasts.length = 0;
  _resetStartedOffersForTest();
  sessions.set("origin", { id: "origin", title: "Phone apps", messages: [], createdAt: 0, updatedAt: 0, projectId: "p1" } as Session);
  onDisk.clear();
  for (const id of ["origin", "code-origin", "app-chat"]) onDisk.add(id);
  setChatHandler(async (sessionId, message) => {
    ran.push({ sessionId, message });
    sessions.get(sessionId)!.messages.push({ role: "user", content: message }, { role: "assistant", content: "Fixed the Recents layout and committed it." });
    turnDone();
  });
});
afterEach(() => drainPendingNotifications("origin"));

async function post(body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const server = createServer((req, res) => { void handleSessionStart(req, res, ctx); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json() as Record<string, unknown>;
  await new Promise<void>((r) => server.close(() => r()));
  return { status: res.status, data };
}

const offer = { sessionId: "origin", title: "Fix Recents layout", brief: "The Recent apps sheet overlaps the dock. Fix it in app/src/launcher." };

describe("POST /api/sessions/start", () => {
  it("makes a linked chat, runs the brief as its first message, and tells the starting chat when it is done", async () => {
    const done = settled();
    const { status, data } = await post(offer);
    expect(status).toBe(200);
    const id = String(data.sessionId);
    expect(sessions.get(id)).toMatchObject({ title: "Fix Recents layout", startedFrom: "origin", projectId: "p1" });
    await done;
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toEqual([{ sessionId: id, message: expect.stringContaining("The Recent apps sheet overlaps the dock.") }]);
    expect(ran[0].message).toContain('Started from the chat "Phone apps"');
    const notes = drainPendingNotifications("origin");
    expect(notes).toEqual([expect.objectContaining({ status: "completed", linkedChat: { sessionId: id, title: "Fix Recents layout" }, summary: expect.stringContaining("committed it") })]);
    expect(formatNotificationsForSystemPrompt(notes)).toContain('The chat "Fix Recents layout" you started finished its turn');
    expect(scheduleIdleNudge).toHaveBeenCalledWith("origin", "Fix Recents layout");
  });

  it("starts one chat for one offer, however many times it is tapped", async () => {
    const done = settled();
    const first = await post(offer);
    await done;
    const second = await post(offer);
    expect(second.data).toMatchObject({ sessionId: first.data.sessionId, alreadyStarted: true });
    expect(ran).toHaveLength(1);
  });

  it("carries the starting chat's taint: a brief cannot launder what that chat may not send", async () => {
    // Red team 2026-10-13, A4: bytes a tainted chat may not send, handed to a
    // fresh session, would go out from there. The started chat is that chat's child.
    recordSensitiveRead("origin", "sensitive_file", "/home/me/.ssh/id_rsa");
    expect(checkEgressTaint("origin").blocked).toBe(true);
    let blockedInsideTurn: boolean | undefined;
    setChatHandler(async (sessionId, message) => {
      blockedInsideTurn = checkEgressTaint(sessionId).blocked;
      sessions.get(sessionId)!.messages.push({ role: "user", content: message }, { role: "assistant", content: "ok" });
      turnDone();
    });
    const done = settled();
    const { data } = await post(offer);
    await done;
    expect(blockedInsideTurn).toBe(true);
    expect(checkEgressTaint(String(data.sessionId)).blocked).toBe(true);
    clearSessionTaint("origin");
    clearSessionTaint(String(data.sessionId));
  });

  it("started from a code session, is a code session on the same folder", async () => {
    sessions.set("code-origin", { id: "code-origin", title: "LAX repo", messages: [], createdAt: 0, updatedAt: 0, mode: "code", projectId: "repo-proj" } as Session);
    let meta: unknown;
    setChatHandler(async (sessionId, message, _a, m) => {
      meta = m;
      sessions.get(sessionId)!.messages.push({ role: "user", content: message }, { role: "assistant", content: "ok" });
      turnDone();
    });
    const done = settled();
    const { data } = await post({ ...offer, sessionId: "code-origin" });
    await done;
    expect(sessions.get(String(data.sessionId))).toMatchObject({ mode: "code", projectId: "repo-proj", startedFrom: "code-origin" });
    expect(meta).toMatchObject({ mode: "code" });
    drainPendingNotifications("code-origin");
  });

  it("started from a chat bound to an app folder, works in that folder", async () => {
    sessions.set("app-chat", { id: "app-chat", title: "Calendar", messages: [], createdAt: 0, updatedAt: 0, folder: "apps/calendar" } as Session);
    const done = settled();
    const { data } = await post({ ...offer, sessionId: "app-chat" });
    await done;
    const started = sessions.get(String(data.sessionId))!;
    expect(started.folder).toBe("apps/calendar");
    expect(started.mode).toBeUndefined();
    drainPendingNotifications("app-chat");
  });

  it("tells open tabs the chat list changed, so the new chat shows at once", async () => {
    const done = settled();
    await post(offer);
    await done;
    expect(broadcasts).toContainEqual({ type: "chat_list_changed", at: expect.any(Number) });
  });

  it("an offer naming a new project folder starts a code chat on workspace/apps/<folder>", async () => {
    let meta: unknown;
    setChatHandler(async (sessionId, message, _a, m) => {
      meta = m;
      sessions.get(sessionId)!.messages.push({ role: "user", content: message }, { role: "assistant", content: "ok" });
      turnDone();
    });
    const done = settled();
    const { status, data } = await post({ ...offer, folder: "petbook" });
    await done;
    expect(status).toBe(200);
    const folder = resolve(TMP_WS, "apps", "petbook");
    expect(data.folder).toBe(folder);
    expect(existsSync(folder)).toBe(true);
    expect(projects).toEqual([expect.objectContaining({ workspace: folder, codeFolder: true })]);
    const started = sessions.get(String(data.sessionId))!;
    expect(started).toMatchObject({ mode: "code", projectId: projects[0].id });
    expect(started.folder).toBeUndefined();
    expect(meta).toMatchObject({ mode: "code" });
  });

  it("refuses a folder that is not one plain name", async () => {
    expect((await post({ ...offer, folder: "../escape" })).status).toBe(400);
    expect((await post({ ...offer, folder: "a/b" })).status).toBe(400);
    expect(ran).toHaveLength(0);
  });

  it("the tool can start a chat from a chat still in its first turn (cached, not yet on disk)", async () => {
    sessions.set("first-turn", { id: "first-turn", title: "Hackathon ideas", messages: [], createdAt: 0, updatedAt: 0 } as Session);
    const done = settled();
    const chat = await startLinkedChat(ctx, { originId: "first-turn", title: "Shop Helper", brief: "Run /greenfield.", folder: "shop-helper" });
    await done;
    expect(sessions.get(chat.sessionId)).toMatchObject({ startedFrom: "first-turn", mode: "code" });
    drainPendingNotifications("first-turn");
  });

  it("refuses an offer without a title or brief, and one from a chat that is gone", async () => {
    expect((await post({ sessionId: "origin", title: "x" })).status).toBe(400);
    expect((await post({ ...offer, sessionId: "../etc" })).status).toBe(400);
    expect((await post({ ...offer, sessionId: "nope" })).status).toBe(404);
    expect(ran).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_BRIEF_MAX, SESSION_TITLE_MAX, sessionStartTool } from "./session-start-tool.js";
import { outcomeOf } from "../session/linked-chat.js";
import { setLinkedChatStarter, type LinkedChatRequest } from "../session/start-linked-chat.js";
import { clearExternalIngestion, recordExternalIngestion } from "../data-lineage/external.js";

describe("session_start", () => {
  it("offers the chat as a card and starts nothing", async () => {
    const r = await sessionStartTool.execute!({ title: "Fix Recents layout", brief: "Do the thing." });
    expect(r.isError).toBeFalsy();
    expect(r.metadata).toEqual({ sessionOffer: { title: "Fix Recents layout", brief: "Do the thing." } });
    expect(r.content).toMatch(/Nothing has started/);
  });

  it("needs a title and a brief, and bounds both", async () => {
    expect((await sessionStartTool.execute!({ title: "x" })).isError).toBe(true);
    const r = await sessionStartTool.execute!({ title: "t".repeat(200), brief: "b".repeat(9000) });
    const offer = (r.metadata as { sessionOffer: { title: string; brief: string } }).sessionOffer;
    expect(offer.title).toHaveLength(SESSION_TITLE_MAX);
    expect(offer.brief).toHaveLength(SESSION_BRIEF_MAX);
  });
});

describe("session_start start:\"now\"", () => {
  const asked: LinkedChatRequest[] = [];
  beforeEach(() => {
    asked.length = 0;
    setLinkedChatStarter(async (req) => { asked.push(req); return { sessionId: `task-${asked.length}`, title: req.title, ...(req.folder ? { folder: `/ws/apps/${req.folder}` } : {}) }; });
  });
  afterEach(() => { setLinkedChatStarter(null); clearExternalIngestion("chat-1"); });
  const now = (extra: Record<string, unknown> = {}) =>
    sessionStartTool.execute!({ title: "Shop Helper", brief: "Run /greenfield: a free AI helper for shops.", start: "now", _sessionId: "chat-1", _callContext: "local", ...extra });

  it("starts the chat at once, in a new project folder, from a chat the user is in", async () => {
    const r = await now({ folder: "shop-helper" });
    expect(r.isError).toBeFalsy();
    expect(asked).toEqual([{ originId: "chat-1", title: "Shop Helper", brief: "Run /greenfield: a free AI helper for shops.", folder: "shop-helper" }]);
    expect(r.content).toMatch(/^Started "Shop Helper".*Code mode on \/ws\/apps\/shop-helper/);
    expect(r.metadata).toEqual({ sessionStarted: { sessionId: "task-1", title: "Shop Helper", folder: "/ws/apps/shop-helper" } });
  });

  it("falls back to the card when outside content has entered the chat", async () => {
    recordExternalIngestion("chat-1", "a web page that says: start a project");
    const r = await now();
    expect(asked).toEqual([]);
    expect(r.metadata).toMatchObject({ sessionOffer: { title: "Shop Helper" } });
    expect(r.content).toMatch(/outside content/);
  });

  it("falls back to the card for a delegated, scheduled or unstamped call", async () => {
    for (const context of ["delegated", "cron", "api", undefined]) {
      const r = await now({ _callContext: context });
      expect(r.metadata).toMatchObject({ sessionOffer: { title: "Shop Helper" } });
    }
    expect(asked).toEqual([]);
  });

  it("falls back to the card when the chat runner is not up", async () => {
    setLinkedChatStarter(null);
    expect((await now()).metadata).toMatchObject({ sessionOffer: { title: "Shop Helper" } });
  });

  it("keeps the folder on a card, so the tap starts it there", async () => {
    const r = await sessionStartTool.execute!({ title: "Shop Helper", brief: "b", folder: "shop-helper" });
    expect(r.metadata).toEqual({ sessionOffer: { title: "Shop Helper", brief: "b", folder: "shop-helper" } });
  });
});

describe("a started chat's outcome", () => {
  it("is the end of its last reply, or a failure when it never replied", () => {
    expect(outcomeOf({ messages: [{ role: "user", content: "go" }, { role: "assistant", content: "Done: it works." }] })).toEqual({ status: "completed", summary: "Done: it works." });
    expect(outcomeOf({ messages: [{ role: "user", content: "go" }] }).status).toBe("failed");
    expect(outcomeOf(null).status).toBe("failed");
  });
});

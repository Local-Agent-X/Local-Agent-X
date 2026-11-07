import { describe, expect, it } from "vitest";
import { SESSION_BRIEF_MAX, SESSION_TITLE_MAX, sessionStartTool } from "./session-start-tool.js";
import { outcomeOf } from "../session/linked-chat.js";

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

describe("a started chat's outcome", () => {
  it("is the end of its last reply, or a failure when it never replied", () => {
    expect(outcomeOf({ messages: [{ role: "user", content: "go" }, { role: "assistant", content: "Done: it works." }] })).toEqual({ status: "completed", summary: "Done: it works." });
    expect(outcomeOf({ messages: [{ role: "user", content: "go" }] }).status).toBe("failed");
    expect(outcomeOf(null).status).toBe("failed");
  });
});

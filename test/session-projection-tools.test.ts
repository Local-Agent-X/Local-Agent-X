// projectSessionForUI collapses each assistant TURN into a single UI bubble
// carrying one consolidated `_tools` array — matching the live view's
// one-bubble-per-turn shape (promoteLiveToMessages). Regression guard for the
// "a little Agent-activity bar under every step" reload look: the projection
// used to flush a separate bubble at each intermediate text entry, so a turn
// that narrated between tool calls reloaded as several bars instead of one.
import { describe, it, expect } from "vitest";
import { projectSessionForUI } from "../src/memory/session-message-log.js";
import type { Session } from "../src/types.js";

// Minimal message factories (loose typing — the projection only reads role,
// content, tool_calls, tool_call_id).
const user = (content: string) => ({ role: "user", content }) as never;
const asstText = (content: string) => ({ role: "assistant", content }) as never;
const asstCall = (id: string, name: string, args: Record<string, unknown> = {}) =>
  ({ role: "assistant", content: "", tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] }) as never;
const toolResult = (id: string, content: string) =>
  ({ role: "tool", tool_call_id: id, content }) as never;

const sess = (messages: unknown[]): Session => ({
  id: "s1", title: "t", createdAt: 0, updatedAt: 0, messages: messages as Session["messages"],
});

type UIAssistant = { role: string; content: string; _tools?: { type: string; name: string }[] };

describe("projectSessionForUI — one bubble + one tool bar per turn", () => {
  it("consolidates text→tool→text→tool→text into ONE bubble with all tools in order", () => {
    const s = sess([
      user("wire it up"),
      asstText("Fixing auth config and retesting."),
      asstCall("c1", "read", { path: "connector.ts" }),
      toolResult("c1", "ok"),
      asstCall("c2", "edit", { path: "auth.ts" }),
      toolResult("c2", "done"),
      asstText("Live API works. Checking items."),
      asstCall("c3", "http_request", { url: "/v3/items" }),
      toolResult("c3", "200 OK"),
      asstText("All set."),
    ]);

    const out = projectSessionForUI(s).messages as UIAssistant[];
    // user prompt + exactly ONE assistant bubble for the whole turn.
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    const asst = out[1];
    // All narration joined into one bubble.
    expect(asst.content).toBe("Fixing auth config and retesting.\n\nLive API works. Checking items.\n\nAll set.");
    // ONE _tools array with every call of the turn, in order.
    expect(asst._tools!.filter((t) => t.type === "start").map((t) => t.name)).toEqual(["read", "edit", "http_request"]);
  });

  it("a tools-only turn (no narration) still emits one bubble with the activity bar", () => {
    const s = sess([
      user("check it"),
      asstCall("c1", "bash", { command: "ls" }),
      toolResult("c1", "a\nb"),
    ]);
    const out = projectSessionForUI(s).messages as UIAssistant[];
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out[1].content).toBe("");
    expect(out[1]._tools!.filter((t) => t.type === "start")).toHaveLength(1);
  });

  it("keeps turns separate — each user prompt starts a fresh single bubble", () => {
    const s = sess([
      user("one"),
      asstCall("c1", "read"),
      toolResult("c1", "x"),
      asstText("first done"),
      user("two"),
      asstText("second done"),
    ]);
    const out = projectSessionForUI(s).messages as UIAssistant[];
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(out[1]._tools!.filter((t) => t.type === "start")).toHaveLength(1);
    expect(out[1].content).toBe("first done");
    // Second turn had no tools → no bar.
    expect(out[3]._tools).toBeUndefined();
    expect(out[3].content).toBe("second done");
  });
});

// The reloaded card carries what the live tool_end carried: the result's
// metadata and the media file's name, off the row's carry, never the text.
describe("projectSessionForUI — the end event carries the row's metadata and media", () => {
  type EndEvent = { type: string; status?: string; metadata?: Record<string, unknown>; media?: { kind: string; name: string } };
  const endOf = (s: Session) => (projectSessionForUI(s).messages[1] as { _tools: EndEvent[] })._tools.find((t) => t.type === "end")!;

  it("metadata and media come off the carry; the absolute path never reaches the client", () => {
    const end = endOf(sess([
      user("draw it"),
      asstCall("c1", "generate_image", { prompt: "a dog" }),
      {
        role: "tool", tool_call_id: "c1", content: "Image generated!\nSaved: C:\\ws\\images\\dog.png",
        _status: "ok", _metadata: { duration_ms: 1200 },
        _media: { kind: "image", path: "C:\\ws\\images\\dog.png", mime: "image/png" },
      } as never,
    ]));
    expect(end.status).toBe("ok");
    expect(end.metadata).toEqual({ duration_ms: 1200 });
    expect(end.media).toEqual({ kind: "image", name: "dog.png" });
    expect(JSON.stringify(end.media)).not.toContain("C:\\\\ws");
  });

  it("a refusal's block scalars lie over its metadata, so the notice still keys on the layer", () => {
    const end = endOf(sess([
      user("send it"),
      asstCall("c1", "bash", { command: "curl x" }),
      {
        role: "tool", tool_call_id: "c1", content: "[blocked, layer=\"data-lineage\"]\nrefused",
        _status: "blocked", _metadata: { exit_code: 1, layer: "data-lineage", recovery: "Ask.", clearable: "declassify" },
        _block: { layer: "data-lineage", reason: "refused", recovery: "Ask.", clearable: "declassify", scope: "session-memory", notice: "declassify-card" },
      } as never,
    ]));
    expect(end.status).toBe("blocked");
    expect(end.metadata).toMatchObject({ exit_code: 1, layer: "data-lineage", clearable: "declassify", scope: "session-memory" });
    expect(end.media).toBeUndefined();
  });

  it("a row written before the carry held them has neither, like before", () => {
    const end = endOf(sess([user("x"), asstCall("c1", "read"), toolResult("c1", "ok")]));
    expect(end.metadata).toBeUndefined();
    expect(end.media).toBeUndefined();
  });
});

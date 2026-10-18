import { describe, it, expect } from "vitest";
import { opMessageRowToChatParam, foldSystemRowsIntoPrompt } from "./message-convert.js";
import type { OpMessageRow } from "../types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

function userRow(content: unknown): OpMessageRow {
  return { messageId: "um-x", opId: "op-x", turnIdx: 0, seqInTurn: 0, role: "user", content, createdAt: "" } as OpMessageRow;
}

describe("opMessageRowToChatParam — user images", () => {
  it("carries attachments onto the session message", () => {
    const row = userRow({ text: "Is that guy fat?", images: [{ name: "a.jpg", url: "/uploads/att-1.jpeg", filePath: "/abs/att-1.jpeg" }] });
    const param = opMessageRowToChatParam(row) as { role: string; content: string; images?: Array<{ name: string; url: string }> };
    expect(param).not.toBeNull();
    expect(param.content).toBe("Is that guy fat?");
    // filePath is dropped — only {name,url} reach the frontend.
    expect(param.images).toEqual([{ name: "a.jpg", url: "/uploads/att-1.jpeg" }]);
  });

  it("keeps a caption-less photo send (empty text but has images)", () => {
    const row = userRow({ text: "", images: [{ name: "kitchen.jpg", url: "/uploads/att-2.jpeg" }] });
    const param = opMessageRowToChatParam(row) as { role: string; content: string; images?: unknown[] };
    expect(param).not.toBeNull();
    expect(param.role).toBe("user");
    expect(param.images).toHaveLength(1);
  });

  it("still drops an empty user row with no images", () => {
    expect(opMessageRowToChatParam(userRow({ text: "" }))).toBeNull();
  });

  it("drops a row whose image entries are malformed (no url)", () => {
    expect(opMessageRowToChatParam(userRow({ text: "", images: [{ name: "x" }] }))).toBeNull();
  });
});

// The dispatch status and the block record the turn loop wrote on the row
// become the session message's carry, so a reloaded chat reads the status and
// rebuilds the block notice without parsing the rendered text.
describe("opMessageRowToChatParam — tool results carry their envelope", () => {
  const toolRow = (content: unknown): OpMessageRow =>
    ({ messageId: "tm-x", opId: "op-x", turnIdx: 0, seqInTurn: 1, role: "tool_result", content, createdAt: "" }) as OpMessageRow;
  type Carried = { role: string; content: string; _status?: string; _block?: { layer: string } };

  it("the status rides as _status", () => {
    const param = opMessageRowToChatParam(toolRow({ toolCallId: "t1", result: "[ok]\ndone", status: "ok" })) as Carried;
    expect(param).toMatchObject({ role: "tool", content: "[ok]\ndone", _status: "ok" });
  });

  it("a refusal carries its block record beside its status", () => {
    const block = { layer: "arikernel", reason: "r", notice: "kernel-notice", scope: "operation" };
    const param = opMessageRowToChatParam(toolRow({ toolCallId: "t1", result: "[blocked]\nrefused", status: "blocked", block })) as Carried;
    expect(param._status).toBe("blocked");
    expect(param._block).toEqual(block);
  });

  it("a cancelled row carries no status: that is op bookkeeping, not an envelope", () => {
    const param = opMessageRowToChatParam(toolRow({ toolCallId: "t1", result: "stopped", status: "cancelled" })) as Carried;
    expect(param._status).toBeUndefined();
  });

  it("a row re-seeded from history with no status carries none, so readers see its header", () => {
    const param = opMessageRowToChatParam(toolRow({ toolCallId: "t1", text: "[error]\nold" })) as Carried;
    expect(param.content).toBe("[error]\nold");
    expect(param._status).toBeUndefined();
  });

  // The metadata and the media path the dispatcher lifted off the tool message
  // ride the row (dispatch-tools.ts) and come back as the message's carry.
  it("the result's metadata rides as _metadata and the media path as _media", () => {
    const metadata = { exit_code: 1, duration_ms: 57, sandboxMode: "guarded" };
    const media = { kind: "image", path: "C:\\ws\\images\\x.png", mime: "image/png" };
    const param = opMessageRowToChatParam(toolRow({ toolCallId: "t1", result: { text: "[error]\nboom", media }, status: "error", metadata })) as Carried & { _metadata?: unknown; _media?: unknown };
    expect(param.content).toBe("[error]\nboom");
    expect(param._metadata).toEqual(metadata);
    expect(param._media).toEqual(media);
  });

  it("a row written before the carry held them carries neither", () => {
    const param = opMessageRowToChatParam(toolRow({ toolCallId: "t1", result: "[ok]\ndone", status: "ok" })) as Carried & { _metadata?: unknown; _media?: unknown };
    expect(param).not.toHaveProperty("_metadata");
    expect(param).not.toHaveProperty("_media");
  });
});

describe("foldSystemRowsIntoPrompt — compaction/truncation digests reach the model", () => {
  const base = "BASE SYSTEM PROMPT";

  it("folds a leading compaction summary into the system prompt", () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "[COMPACTED CONTEXT — summary of the last 200 turns]" },
      { role: "user", content: "carry on" },
    ];
    const out = foldSystemRowsIntoPrompt(base, history);
    // This is the invariant PR-9 restores: the compaction summary, which the
    // canonical seed drops as a system ROW, must survive in the system prompt.
    expect(out).toContain("[COMPACTED CONTEXT — summary of the last 200 turns]");
    expect(out.startsWith(base)).toBe(true);
  });

  it("folds truncateHistory's <prior_conversation> digest in too", () => {
    const digest = '<prior_conversation count="42">\n…earlier context…\n</prior_conversation>';
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: digest },
      { role: "assistant", content: "ok" },
    ];
    expect(foldSystemRowsIntoPrompt(base, history)).toContain(digest);
  });

  it("folds multiple system rows (preserved compaction leader + auto digest)", () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "COMPACT_SUMMARY" },
      { role: "system", content: "AUTO_DIGEST" },
      { role: "user", content: "next" },
    ];
    const out = foldSystemRowsIntoPrompt(base, history);
    expect(out).toContain("COMPACT_SUMMARY");
    expect(out).toContain("AUTO_DIGEST");
  });

  it("returns the prompt unchanged when there are no system rows", () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(foldSystemRowsIntoPrompt(base, history)).toBe(base);
  });

  it("skips whitespace-only system rows (no empty padding)", () => {
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: "   " },
      { role: "user", content: "hi" },
    ];
    expect(foldSystemRowsIntoPrompt(base, history)).toBe(base);
  });
});

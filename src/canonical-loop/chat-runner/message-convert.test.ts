import { describe, it, expect } from "vitest";
import { opMessageRowToChatParam } from "./message-convert.js";
import type { OpMessageRow } from "../types.js";

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

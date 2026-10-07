import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../types.js";
import { readSessionLog, recordMessageProvenance, writeSessionLog } from "./session-message-log.js";

// A session row carries its message's identity and time; the message object
// (sent to providers as is) never does. A chat turn records the op store's
// own id and time for the rows it adopts, so both stores agree.
describe("session message provenance", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const msgRows = (id: string) => readFileSync(join(dir, `${id}.jsonl`), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).filter((r) => r.kind === "msg");

  it("persists the op row's id and time for an adopted message, and mints a stable id for the rest", () => {
    dir = mkdtempSync(join(tmpdir(), "lax-prov-"));
    const user = { role: "user" as const, content: "car ride today" };
    const reply = { role: "assistant" as const, content: "the 2011 story?" };
    recordMessageProvenance(user, { id: "um-op_chat_turn_x-init-1", createdAt: "2026-10-07T17:28:16.608Z" });
    const s: Session = { id: "chat-p", title: "p", createdAt: 0, updatedAt: 0, messages: [user, reply] };
    writeSessionLog(dir, s);
    const [u, a] = msgRows("chat-p");
    expect(u).toMatchObject({ id: "um-op_chat_turn_x-init-1", createdAt: "2026-10-07T17:28:16.608Z" });
    expect(a.id).toMatch(/^sm-[0-9a-f-]{36}$/);
    expect(JSON.stringify(u.message)).not.toContain("um-op_chat_turn");

    writeSessionLog(dir, s); // a second save keeps the minted id
    expect(msgRows("chat-p")[1].id).toBe(a.id);
    const reloaded = readSessionLog(dir, "chat-p")!; // a reload too
    writeSessionLog(dir, reloaded);
    expect(msgRows("chat-p").map((r) => r.id)).toEqual(["um-op_chat_turn_x-init-1", a.id]);
  });

  it("a legacy row without an id gets one on its next save, once", () => {
    dir = mkdtempSync(join(tmpdir(), "lax-prov-"));
    const s: Session = { id: "chat-l", title: "l", createdAt: 0, updatedAt: 0, messages: [{ role: "user", content: "old" }] };
    writeSessionLog(dir, s);
    const loaded = readSessionLog(dir, "chat-l")!;
    writeSessionLog(dir, loaded);
    const first = msgRows("chat-l")[0].id;
    writeSessionLog(dir, readSessionLog(dir, "chat-l")!);
    expect(msgRows("chat-l")[0].id).toBe(first);
  });
});

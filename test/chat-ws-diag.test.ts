// @vitest-environment happy-dom
// The desktop page's record of its chat socket (public/js/chat-ws-diag.js):
// what it last received per chat and why its socket last went away, sent to
// the server on the next connect.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

new Function(readFileSync(join(__dirname, "..", "public", "js", "chat-ws-diag.js"), "utf8"))();
const diag = (window as any).laxWsDiag;

describe("the page's socket record", () => {
  it("reports the drop, the time down and the last frame per chat on reconnect", () => {
    const sent: any[] = [];
    const ws = { send: (s: string) => sent.push(JSON.parse(s)) };
    diag.report(ws);
    expect(sent[0]).toMatchObject({ type: "client_diag", reconnect: false });

    diag.noteFrame({ type: "event", sessionId: "s1", event: { type: "user_message" } });
    diag.noteFrame({ type: "chat_op_started", sessionId: "s2" });
    diag.noteFrame({ type: "pong" });
    diag.noteDrop("closed code=1006");
    diag.noteDrop("retired: later cause");
    diag.report(ws);
    const second = sent[1];
    expect(second.reconnect).toBe(true);
    expect(second.dropReason).toBe("closed code=1006");
    expect(second.lastReceived.map((r: any) => `${r.sessionId}:${r.type}`).sort()).toEqual(["s1:user_message", "s2:chat_op_started"]);

    diag.report(ws);
    expect(sent[2].reconnect).toBe(false);
  });
});

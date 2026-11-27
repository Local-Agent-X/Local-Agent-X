import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const lines: string[] = [];
vi.mock("../logger.js", () => ({
  createLogger: () => ({ info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) }),
}));

const { noteClientReport, noteConnected, noteSent, noteSubscribed, noteTurnAudience, noteNoPong } = await import("./connection-log.js");

function socket(): any {
  const ws = new EventEmitter() as any;
  ws.readyState = 1;
  return ws;
}

describe("the chat socket record", () => {
  it("says which sockets a turn reaches, and flags an open page not listening to that chat", () => {
    lines.length = 0;
    const page = socket();
    const phone = socket();
    noteConnected(page, true);
    noteConnected(phone, false);
    noteSubscribed(phone, "s1");
    noteSent(phone, "s1", "done");
    const clients = new Map([[page, new Set(["s2"])], [phone, new Set(["s1"])]]);
    noteTurnAudience("s1", clients);
    const turn = lines.at(-1)!;
    expect(turn).toMatch(/turn on s1 reaches #\d+ bridge \(last sent done/);
    expect(turn).toContain("1 browser socket(s) open, none listening to this chat");
  });

  it("logs a close with its code, lifetime and the last frames sent", () => {
    lines.length = 0;
    const page = socket();
    noteConnected(page, true);
    noteSent(page, "s1", "stream");
    noteNoPong(page);
    page.emit("close", 1006, Buffer.from(""));
    expect(lines.some((l) => /missed its heartbeat/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/browser closed code=1006 after \d+s; last sent s1: stream at/);
  });

  it("logs the page's own report of a drop and what it last received", () => {
    lines.length = 0;
    const page = socket();
    noteConnected(page, true);
    noteClientReport(page, {
      reconnect: true, dropReason: "closed code=1006", downMs: 3200, lastConnectedMs: 600000,
      lastReceived: [{ sessionId: "s1", type: "done", agoMs: 4000 }, { sessionId: "<b>x</b>", type: "stream", agoMs: 1 }],
    });
    const line = lines.at(-1)!;
    expect(line).toMatch(/page reports reconnected after 3s down \(closed code=1006; previous socket lived 600s\); last received s1: done 4s ago/);
    expect(line).not.toContain("<b>");
  });

  it("a turn no socket listens to says so", () => {
    lines.length = 0;
    noteTurnAudience("lonely", new Map());
    expect(lines.at(-1)).toBe("[ws-conn] turn on lonely reaches no socket");
  });
});

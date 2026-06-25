// ChatBridge tests — the data-channel ⇄ loopback /ws/chat relay, with NO real ws and
// NO real data channel. A fake ControlTransport stands in for the broker `chat` channel;
// a fake LoopbackChatSocket stands in for the desktop's own /ws/chat.

import { describe, it, expect } from "vitest";
import { ChatBridge, type LoopbackChatSocket } from "./chat-bridge.js";
import type { ControlTransport } from "../screen-stream/peer.js";

class FakeTransport implements ControlTransport {
  sent: string[] = [];
  private msg: ((t: string) => void) | null = null;
  private cls: (() => void) | null = null;
  send(text: string): void {
    this.sent.push(text);
  }
  onMessage(h: (t: string) => void): void {
    this.msg = h;
  }
  onClose(h: () => void): void {
    this.cls = h;
  }
  /** driver: the phone sent a chat frame over the data channel. */
  emit(obj: unknown): void {
    this.msg?.(JSON.stringify(obj));
  }
  /** driver: the data channel closed. */
  drop(): void {
    this.cls?.();
  }
}

class FakeLoopback implements LoopbackChatSocket {
  sent: string[] = [];
  closed = false;
  private openH: (() => void) | null = null;
  private msg: ((t: string) => void) | null = null;
  private cls: (() => void) | null = null;
  send(text: string): void {
    this.sent.push(text);
  }
  onOpen(h: () => void): void {
    this.openH = h;
  }
  onMessage(h: (t: string) => void): void {
    this.msg = h;
  }
  onClose(h: () => void): void {
    this.cls = h;
  }
  close(): void {
    this.closed = true;
  }
  /** drivers */
  open(): void {
    this.openH?.();
  }
  serverSend(obj: unknown): void {
    this.msg?.(JSON.stringify(obj));
  }
  serverClose(): void {
    this.cls?.();
  }
  get sentFrames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function setup() {
  const loopback = new FakeLoopback();
  const bridge = new ChatBridge({ openLoopback: () => loopback });
  const transport = new FakeTransport();
  return { loopback, bridge, transport };
}

describe("ChatBridge", () => {
  it("relays phone chat frames to the loopback server once it is open", () => {
    const { loopback, bridge, transport } = setup();
    bridge.attach(transport);
    loopback.open();

    transport.emit({ type: "chat", sessionId: "s1", message: "hi" });
    expect(loopback.sentFrames).toEqual([{ type: "chat", sessionId: "s1", message: "hi" }]);
  });

  it("BUFFERS phone frames sent before the loopback ws connects, then flushes in order", () => {
    const { loopback, bridge, transport } = setup();
    bridge.attach(transport);

    // Phone speaks before the loopback finished connecting.
    transport.emit({ type: "subscribe", sessionId: "s1" });
    transport.emit({ type: "chat", sessionId: "s1", message: "first" });
    expect(loopback.sent).toHaveLength(0); // nothing forwarded yet

    loopback.open();
    expect(loopback.sentFrames).toEqual([
      { type: "subscribe", sessionId: "s1" },
      { type: "chat", sessionId: "s1", message: "first" },
    ]);
  });

  it("relays server events back to the phone over the data channel", () => {
    const { loopback, bridge, transport } = setup();
    bridge.attach(transport);
    loopback.open();

    loopback.serverSend({ type: "event", sessionId: "s1", event: { kind: "token", text: "yo" } });
    expect(transport.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "event", sessionId: "s1", event: { kind: "token", text: "yo" } },
    ]);
  });

  it("closes the loopback when the data channel closes", () => {
    const { loopback, bridge, transport } = setup();
    bridge.attach(transport);
    loopback.open();

    transport.drop();
    expect(loopback.closed).toBe(true);
  });

  it("stops forwarding after close (idempotent)", () => {
    const { loopback, bridge, transport } = setup();
    bridge.attach(transport);
    loopback.open();

    bridge.close();
    bridge.close(); // idempotent
    transport.emit({ type: "chat", sessionId: "s1", message: "late" });
    expect(loopback.sent).toHaveLength(0);
    expect(loopback.closed).toBe(true);
  });

  it("survives a loopback drop without throwing (data channel stays for re-bridge)", () => {
    const { loopback, bridge, transport } = setup();
    bridge.attach(transport);
    loopback.open();
    loopback.serverClose();
    // A frame after the loopback dropped is buffered, not thrown.
    expect(() => transport.emit({ type: "chat", sessionId: "s1", message: "x" })).not.toThrow();
  });
});

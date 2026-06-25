// ChatBridge — carries chat over the broker peer instead of the tailnet.
//
// WHY: over the tailnet the phone opened a WebSocket to the desktop's /ws/chat (on the
// 100.x.x.x bind) and spoke the chat protocol (chat/stop/subscribe ⇄ event/active_chats).
// Off the tailnet, that same protocol rides the broker peer's `chat` DATA CHANNEL (E2E,
// no third party). This bridge sits on the DESKTOP and relays that data channel to the
// desktop's OWN /ws/chat over loopback (127.0.0.1) — so the chat pipeline (chat-ws,
// run-turn, sessions) is completely UNCHANGED: the bridge is just another local client,
// exactly as the tailnet phone was. The phone sends byte-identical frames either way.
//
// Pure over an injected loopback-socket factory so the relay + buffering unit-tests with
// fakes (no real ws, no real data channel). The production factory opens a real ws to
// ws://127.0.0.1:<port>/ws/chat with the operator token.

import type { ControlTransport } from "../screen-stream/peer.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.chat-bridge");

/** A minimal loopback WS client to the desktop's own /ws/chat. Connects async, so
 *  `onOpen` fires once it's ready (sends before that are buffered by the bridge). */
export interface LoopbackChatSocket {
  send(text: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface ChatBridgeDeps {
  /** Open a fresh operator-authed loopback ws to /ws/chat. */
  openLoopback: () => LoopbackChatSocket;
}

/** The chat seam the broker dialer wires the peer's `chat` data channel into. ChatBridge
 *  is the real impl (relays to loopback /ws/chat); NullChatChannel drops chat (used when
 *  chat-over-broker isn't wired — tests, or a view-only build). */
export interface ChatChannel {
  attach(transport: ControlTransport): void;
  close(): void;
}

/** Inert ChatChannel: the broker `chat` data channel is never bridged (chat stays on the
 *  tailnet). Lets the dialer default to "no chat over broker" without a null check. */
export class NullChatChannel implements ChatChannel {
  attach(_transport: ControlTransport): void {
    /* chat not bridged */
  }
  close(): void {
    /* nothing to tear down */
  }
}

/**
 * Relays one broker `chat` data channel ⇄ one loopback /ws/chat connection:
 *   data channel → loopback   (the phone's chat/stop/subscribe frames)
 *   loopback → data channel   (the server's event/active_chats frames)
 * Frames the phone sends before the loopback ws finishes connecting are BUFFERED and
 * flushed on open, so the first message after pairing isn't lost.
 */
export class ChatBridge implements ChatChannel {
  private transport: ControlTransport | null = null;
  private socket: LoopbackChatSocket | null = null;
  private socketOpen = false;
  /** Phone→server frames buffered until the loopback ws is open. */
  private readonly pending: string[] = [];
  private closed = false;

  constructor(private readonly deps: ChatBridgeDeps) {}

  /** Wire the data channel to a fresh loopback /ws/chat. Called when the broker peer
   *  surfaces its `chat` channel (already open, so `transport.send` is valid). */
  attach(transport: ControlTransport): void {
    if (this.closed) return;
    this.transport = transport;
    const socket = this.deps.openLoopback();
    this.socket = socket;

    socket.onOpen(() => {
      this.socketOpen = true;
      for (const frame of this.pending) socket.send(frame);
      this.pending.length = 0;
    });
    socket.onMessage((text) => {
      if (!this.closed) transport.send(text); // server event → phone
    });
    socket.onClose(() => {
      // The loopback to our own process dropped (server shutdown / restart). Drop the
      // open flag; the data channel stays so a reconnected server can be re-bridged by
      // a fresh attach. We don't auto-reopen here — the presence/peer lifecycle owns that.
      this.socketOpen = false;
      this.socket = null;
      if (!this.closed) logger.warn("[broker-transport] chat loopback closed");
    });

    transport.onMessage((text) => this.toServer(text)); // phone frame → server
    transport.onClose(() => this.close());
  }

  /** Forward a phone frame to the loopback server, buffering until it's connected. */
  private toServer(text: string): void {
    if (this.closed) return;
    if (this.socketOpen && this.socket) this.socket.send(text);
    else this.pending.push(text);
  }

  /** Tear down with the data channel / session. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
    this.transport = null;
    this.pending.length = 0;
  }
}

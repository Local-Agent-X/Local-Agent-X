// Production LoopbackChatSocket — a real ws client to the desktop's OWN /ws/chat, used
// by the broker ChatBridge to relay chat between the phone's data channel and the local
// chat pipeline. The broker dialer runs IN the server process, so it holds the operator
// token; it connects as the OPERATOR principal (constTime-checked by upgrade-auth), which
// means chat-ws does NOT attach a screen session to it (that's device-principal only) —
// it's a pure chat client, exactly like the desktop UI.

import { WebSocket } from "ws";
import type { LoopbackChatSocket } from "./chat-bridge.js";

/** Open an operator-authed ws to ws://127.0.0.1:<port>/ws/chat. The token rides the
 *  query string (the chat-ws upgrade reads `?token=`), same as the desktop UI. */
export function openBrokerChatLoopback(port: number, operatorToken: string): LoopbackChatSocket {
  const url = `ws://127.0.0.1:${port}/ws/chat?token=${encodeURIComponent(operatorToken)}`;
  const ws = new WebSocket(url);
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    onOpen: (handler) => ws.on("open", handler),
    // chat-ws sends JSON text frames; node-ws delivers a Buffer, so coerce to string.
    onMessage: (handler) => ws.on("message", (data) => handler(data.toString())),
    onClose: (handler) => ws.on("close", () => handler()),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closing/closed */
      }
    },
  };
}

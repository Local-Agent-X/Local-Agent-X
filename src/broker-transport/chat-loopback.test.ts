// The phone's chat channel can close while the desktop's own loopback chat
// socket is still connecting. ws then reports the aborted handshake as an
// 'error' event, which with no listener was an uncaught exception that reached
// the desktop's crash guard (9 times in its log, 2026-11-22).
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { openBrokerChatLoopback } from "./chat-loopback.js";

let server: Server | null = null;
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** A port that accepts the TCP connection and never answers the upgrade, so
 *  the socket stays in CONNECTING for as long as the test wants. */
async function silentPort(): Promise<number> {
  server = createServer((socket) => { sockets.push(socket); });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("the broker's loopback chat socket", () => {
  it("closing it before it has connected raises nothing, and still reports it closed", async () => {
    const chat = openBrokerChatLoopback(await silentPort(), "token");
    const closed = new Promise<void>((resolve) => chat.onClose(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50)); // the TCP connection is up, the upgrade is not
    chat.close();
    await closed;
  });

  it("a server that refuses the connection is a close, not a crash", async () => {
    const port = await silentPort();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    const chat = openBrokerChatLoopback(port, "token");
    await new Promise<void>((resolve) => chat.onClose(resolve));
    expect(true).toBe(true);
  });
});

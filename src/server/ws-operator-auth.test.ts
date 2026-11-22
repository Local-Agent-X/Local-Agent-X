// One way a WebSocket endpoint takes its upgrades (serveOperatorSocket). The
// path routing, the cross-site Origin refusal and the token read were written
// out in chat-ws and again in voice-ws; this is the rule both now run, driven
// through a real http server and a real `ws` client.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { setServerPort } from "../server-utils.js";
import { WS_UNAUTHORIZED, operatorSocketPaths, serveOperatorSocket } from "./ws-operator-auth.js";

const TOKEN = "operator-token-for-tests";
const quiet = { info: () => {}, warn: () => {} };

let server: Server;
let port: number;
let accepted: string[];

beforeEach(async () => {
  accepted = [];
  server = createServer();
  for (const path of ["/ws/alpha", "/ws/beta"]) {
    serveOperatorSocket(server, { path, operatorToken: TOKEN, maxPayloadBytes: 1024, logger: quiet, tag: "test" }, (ws) => {
      accepted.push(path);
      ws.send(`hello from ${path}`);
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  setServerPort(String(port));
});

afterEach(async () => {
  setServerPort("7007");
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Outcome = { message?: string; closeCode?: number; error?: string };

/** Dial, and report the first thing that happens: a message, a close, or an error. */
function dial(path: string, opts: { protocols?: string[]; origin?: string } = {}): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, opts.protocols, opts.origin ? { origin: opts.origin } : undefined);
    ws.on("message", (data) => { resolve({ message: String(data) }); ws.close(); });
    ws.on("close", (code) => resolve({ closeCode: code }));
    ws.on("error", (e) => resolve({ error: e.message }));
  });
}

describe("serveOperatorSocket", () => {
  it("hands each endpoint the connections for its own path", async () => {
    expect(await dial(`/ws/alpha?token=${TOKEN}`)).toEqual({ message: "hello from /ws/alpha" });
    expect(await dial(`/ws/beta?token=${TOKEN}`)).toEqual({ message: "hello from /ws/beta" });
    expect(accepted).toEqual(["/ws/alpha", "/ws/beta"]);
    expect([...operatorSocketPaths(server)]).toEqual(["/ws/alpha", "/ws/beta"]);
  });

  it("takes the token from the lax-auth subprotocol pair, as a browser sends it", async () => {
    expect(await dial("/ws/alpha", { protocols: ["lax-auth", TOKEN] })).toEqual({ message: "hello from /ws/alpha" });
  });

  it("closes a connection with a wrong or missing token, with the unauthorized code", async () => {
    expect(await dial("/ws/alpha?token=wrong")).toEqual({ closeCode: WS_UNAUTHORIZED });
    expect(await dial("/ws/alpha")).toEqual({ closeCode: WS_UNAUTHORIZED });
    expect(accepted).toEqual([]);
  });

  it("refuses a cross-site page's handshake even with the token, and takes this server's own page", async () => {
    const crossSite = await dial(`/ws/alpha?token=${TOKEN}`, { origin: "https://evil.example" });
    expect(crossSite.error).toBeDefined();
    expect(accepted).toEqual([]);
    expect(await dial(`/ws/alpha?token=${TOKEN}`, { origin: `http://127.0.0.1:${port}` })).toEqual({ message: "hello from /ws/alpha" });
  });
});

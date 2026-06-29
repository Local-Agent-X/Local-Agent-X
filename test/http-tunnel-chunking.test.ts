import { describe, it, expect } from "vitest";
import { sendFramed, MAX_CHUNK_CHARS, HttpTunnelBridge } from "../src/broker-transport/http-tunnel-bridge.js";

// A WebRTC data channel caps a single message at ~64KB; a large response (a Vite
// dev module like react-dom is ~800KB) sent whole never reaches the phone → the
// app white-screens. sendFramed splits oversized payloads into ordered chunks
// the phone rejoins by id; small payloads stay a single unwrapped frame.
function fakeTransport() {
  const sent: string[] = [];
  return { sent, send: (t: string) => sent.push(t) };
}

describe("sendFramed — chunking for the 64KB data-channel cap", () => {
  it("sends a small payload as ONE unwrapped frame (REST path byte-for-byte unchanged)", () => {
    const t = fakeTransport();
    const payload = '{"t":"res","id":"1","status":200,"body":"ok"}';
    sendFramed(t, "1", payload);
    expect(t.sent).toEqual([payload]);
  });

  it("splits a large payload into ordered chunks that rejoin to the original", () => {
    const payload = "Y".repeat(MAX_CHUNK_CHARS * 3 + 17); // 3 full chunks + a remainder
    const t = fakeTransport();
    sendFramed(t, "42", payload);

    expect(t.sent.length).toBe(4);
    const frames = t.sent.map((s) => JSON.parse(s) as { t: string; id: string; i: number; n: number; b: string });
    for (const f of frames) {
      expect(f.t).toBe("chunk");
      expect(f.id).toBe("42");
      expect(f.n).toBe(4);
      expect(f.b.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS); // each within the cap
    }
    const rejoined = frames.sort((a, b) => a.i - b.i).map((f) => f.b).join("");
    expect(rejoined).toBe(payload); // lossless
  });

  it("uses ceil(len / MAX_CHUNK_CHARS) chunks on an exact boundary", () => {
    const t = fakeTransport();
    sendFramed(t, "x", "Z".repeat(MAX_CHUNK_CHARS * 2));
    expect(t.sent.length).toBe(2);
  });
});

describe("HttpTunnelBridge — chunking is GATED on the phone's chunked flag (no legacy regression)", () => {
  const bigBody = "A".repeat(MAX_CHUNK_CHARS * 2); // > one frame
  const loopback = () => ({ origin: "http://127.0.0.1:7007", token: "tok" });
  const fetchImpl = (async () =>
    new Response(bigBody, { status: 200, headers: { "content-type": "text/javascript" } })) as unknown as typeof fetch;

  function driveTransport() {
    const sent: string[] = [];
    let onMsg: (t: string) => void = () => {};
    const transport = {
      sent,
      send: (t: string) => sent.push(t),
      onMessage: (h: (t: string) => void) => { onMsg = h; },
      onClose: (_h: () => void) => {},
      emit: (obj: unknown) => onMsg(JSON.stringify(obj)),
    };
    return transport;
  }

  it("chunks a large response when the request advertised chunked:true", async () => {
    const bridge = new HttpTunnelBridge({ loopback, fetchImpl });
    const t = driveTransport();
    bridge.attach(t as unknown as Parameters<typeof bridge.attach>[0]);
    t.emit({ t: "req", id: "1", method: "GET", path: "/apps/x/react-dom.js", chunked: true });
    await new Promise((r) => setTimeout(r, 15));
    expect(t.sent.length).toBeGreaterThan(1);
    expect(JSON.parse(t.sent[0]).t).toBe("chunk");
  });

  it("sends a large response WHOLE for a legacy phone (no chunked flag)", async () => {
    const bridge = new HttpTunnelBridge({ loopback, fetchImpl });
    const t = driveTransport();
    bridge.attach(t as unknown as Parameters<typeof bridge.attach>[0]);
    t.emit({ t: "req", id: "2", method: "GET", path: "/apps/x/react-dom.js" }); // no chunked flag
    await new Promise((r) => setTimeout(r, 15));
    expect(t.sent.length).toBe(1);
    expect(JSON.parse(t.sent[0]).t).toBe("res"); // whole frame, exactly as before
  });

  it("marks every forwarded request x-lax-tunnel so the /apps proxy injects phone live-reload", async () => {
    let seen: Record<string, string> = {};
    const capturing = (async (_u: string, init: { headers: Record<string, string> }) => {
      seen = init.headers;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    const bridge = new HttpTunnelBridge({ loopback, fetchImpl: capturing });
    const t = driveTransport();
    bridge.attach(t as unknown as Parameters<typeof bridge.attach>[0]);
    t.emit({ t: "req", id: "3", method: "GET", path: "/apps/x/" });
    await new Promise((r) => setTimeout(r, 15));
    expect(seen["x-lax-tunnel"]).toBe("1");
  });
});

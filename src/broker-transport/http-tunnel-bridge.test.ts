// HttpTunnelBridge tests — the phone's REST-over-data-channel proxy, with a fake
// ControlTransport (the `http` data channel) and a fake fetch (the loopback server).
// Asserts: device-allowed requests proxy to loopback with the operator token; disallowed
// paths are refused (403) WITHOUT a fetch; the framed response carries status + body.

import { describe, it, expect, vi } from "vitest";
import { HttpTunnelBridge } from "./http-tunnel-bridge.js";
import type { ControlTransport } from "../screen-stream/peer.js";

class FakeTransport implements ControlTransport {
  sent: string[] = [];
  private msg: ((t: string) => void) | null = null;
  send(text: string): void {
    this.sent.push(text);
  }
  onMessage(h: (t: string) => void): void {
    this.msg = h;
  }
  onClose(_h: () => void): void {
    /* unused */
  }
  emit(obj: unknown): void {
    this.msg?.(JSON.stringify(obj));
  }
  /** The last framed response the bridge sent. */
  lastRes(): { t: string; id: string; status: number; body: string } {
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }
}

function fakeResponse(status: number, body: string): Response {
  return {
    status,
    text: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("HttpTunnelBridge", () => {
  it("proxies a device-allowed request to the loopback server with the operator token", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, '[{"id":"a","name":"App A"}]'));
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "req", id: "1", method: "GET", path: "/api/apps" });
    await flush();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:7007/api/apps",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Authorization: "Bearer op-tok" }) }),
    );
    expect(t.lastRes()).toMatchObject({ t: "res", id: "1", status: 200, body: '[{"id":"a","name":"App A"}]' });
  });

  it("refuses a path outside the device allowlist with 403 and never fetches", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, "secret"));
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "req", id: "2", method: "GET", path: "/api/files/etc/passwd" });
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(t.lastRes()).toMatchObject({ id: "2", status: 403 });
  });

  it("ignores non-request frames", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, "x"));
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "res", id: "x", status: 200, body: "noise" }); // a response, not a request
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(t.sent).toHaveLength(0);
  });

  it("returns 502 when the loopback fetch throws (no silent hang)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "req", id: "3", method: "GET", path: "/api/sessions" });
    await flush();
    expect(t.lastRes()).toMatchObject({ id: "3", status: 502 });
  });
});

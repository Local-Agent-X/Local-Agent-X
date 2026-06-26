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

function fakeBinaryResponse(status: number, bytes: Uint8Array, contentType: string): Response {
  return {
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => {
      throw new Error("binary body must not be read as text");
    },
    headers: { get: () => contentType },
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

  it("base64-frames a binary asset and never reads it as text", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]);
    const fetchImpl = vi.fn(async () => fakeBinaryResponse(200, png, "image/png"));
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "req", id: "9", method: "GET", path: "/apps/foo/logo.png" });
    await flush();

    const res = t.lastRes() as { id: string; status: number; enc?: string; body: string };
    expect(res).toMatchObject({ id: "9", status: 200, enc: "base64" });
    expect(Buffer.from(res.body, "base64").equals(Buffer.from(png))).toBe(true);
  });

  it("frames a text response as utf8 with no enc (backward-compatible wire shape)", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, '{"ok":true}'));
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "req", id: "8", method: "GET", path: "/api/apps/foo/state" });
    await flush();

    const res = t.lastRes() as { id: string; body: string; enc?: string };
    expect(res).toMatchObject({ id: "8", body: '{"ok":true}' });
    expect(res.enc).toBeUndefined();
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

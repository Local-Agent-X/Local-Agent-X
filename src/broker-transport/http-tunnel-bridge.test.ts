// HttpTunnelBridge tests — the phone's REST-over-data-channel proxy, with a fake
// ControlTransport (the `http` data channel) and a fake fetch (the loopback server).
// Asserts: device-allowed requests proxy to loopback with the operator token; disallowed
// paths are refused (403) WITHOUT a fetch; the framed response carries status + body.

import { describe, it, expect, vi } from "vitest";
import { deriveFilesLinkCapability } from "../server/agent-file-links.js";
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

  it("frames Office documents as base64 binary — openxmlformats is NOT an xml text type", async () => {
    // Regression: includes("xml") matched application/vnd.openXMLformats and
    // decoded docx/xlsx binaries as lossy UTF-8 text — corrupt on arrival.
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x81]);
    const fetchImpl = vi.fn(async () =>
      fakeBinaryResponse(200, zipMagic, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "req", id: "12", method: "GET", path: "/uploads/abcd1234-budget.xlsx" });
    await flush();

    const res = t.lastRes() as { id: string; status: number; enc?: string; body: string };
    expect(res).toMatchObject({ id: "12", status: 200, enc: "base64" });
    expect(Buffer.from(res.body, "base64").equals(Buffer.from(zipMagic))).toBe(true);
  });

  it("returns 413 for an oversize binary body instead of silently truncating it", async () => {
    // A truncated xlsx is a corrupt xlsx delivered with a 200 — the phone must
    // get a clean error it can surface ("file too large") instead.
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    const fetchImpl = vi.fn(async () =>
      fakeBinaryResponse(200, big, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "req", id: "13", method: "GET", path: "/uploads/huge.xlsx" });
    await flush();

    const res = t.lastRes() as { id: string; status: number; enc?: string; body: string };
    expect(res.status).toBe(413);
    expect(res.enc).toBeUndefined();
    expect(res.body).toContain("too large");
  });

  it("returns 413 for an oversize text body instead of slicing it", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, "x".repeat(8 * 1024 * 1024 + 1)));
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "req", id: "14", method: "GET", path: "/api/sessions/big" });
    await flush();

    expect(t.lastRes().status).toBe(413);
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

// A workspace file answers to the files-link capability (ft), which the phone
// never holds; the bridge adds it, and the server hands the request on to the
// agent origin (2026-10-24).
describe("HttpTunnelBridge — workspace files", () => {
  it("adds the files-link capability to a /files request", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, "ok"));
    const bridge = new HttpTunnelBridge({ loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }), fetchImpl: fetchImpl as unknown as typeof fetch });
    const t = new FakeTransport();
    bridge.attach(t);
    t.emit({ t: "req", id: "f1", method: "GET", path: "/files/resume-agency/resume.pdf" });
    await flush();
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(url.pathname).toBe("/files/resume-agency/resume.pdf");
    expect(url.searchParams.get("ft")).toBe(deriveFilesLinkCapability("op-tok"));
  });

  it("refuses a credential file in the workspace and never fetches", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, "SECRET=1"));
    const bridge = new HttpTunnelBridge({ loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }), fetchImpl: fetchImpl as unknown as typeof fetch });
    const t = new FakeTransport();
    bridge.attach(t);
    t.emit({ t: "req", id: "f2", method: "GET", path: "/files/apps/shop/.env" });
    await flush();
    expect(t.lastRes()).toMatchObject({ id: "f2", status: 403 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("HttpTunnelBridge carries a page's safety headers to the phone", () => {
  // The phone's WebView only enforces an agent-built app's CSP if the tunnel
  // delivers it; with content-type alone the app could connect anywhere.
  it("forwards CSP, Permissions-Policy, Referrer-Policy and nosniff, and nothing else", async () => {
    const upstream = new Headers({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; connect-src 'self'",
      "permissions-policy": "camera=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "set-cookie": "sid=desktop-session",
      "x-powered-by": "lax",
    });
    const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => "<html></html>", headers: upstream }) as unknown as Response);
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "req", id: "h1", method: "GET", path: "/apps/demo/" });
    await flush();

    const res = JSON.parse(t.sent[t.sent.length - 1]!) as { headers: Record<string, string> };
    expect(res.headers).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; connect-src 'self'",
      "permissions-policy": "camera=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
  });
});

// A video plays on the phone in pieces (server/byte-range.ts, 2026-11-26): the
// player's Range goes to the desktop, and the piece comes back as a 206 that
// says where it sits in the file.
describe("HttpTunnelBridge carries a piece of a file", () => {
  it("forwards the player's Range and returns the 206 with its Content-Range", async () => {
    const piece = new Uint8Array([1, 2, 3, 4]);
    const upstream = new Headers({ "content-type": "video/mp4", "content-range": "bytes 0-3/9000000", "accept-ranges": "bytes" });
    const fetchImpl = vi.fn(async () => ({
      status: 206,
      arrayBuffer: async () => piece.buffer.slice(0),
      text: async () => { throw new Error("binary body must not be read as text"); },
      headers: upstream,
    }) as unknown as Response);
    const bridge = new HttpTunnelBridge({
      loopback: () => ({ origin: "http://127.0.0.1:7007", token: "op-tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const t = new FakeTransport();
    bridge.attach(t);

    t.emit({ t: "req", id: "v1", method: "GET", path: "/videos/clip.mp4", headers: { range: "bytes=0-" } });
    await flush();

    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ range: "bytes=0-" }) }));
    const res = JSON.parse(t.sent[t.sent.length - 1]!) as { status: number; enc: string; headers: Record<string, string> };
    expect(res).toMatchObject({ status: 206, enc: "base64" });
    expect(res.headers).toEqual({ "content-type": "video/mp4", "content-range": "bytes 0-3/9000000", "accept-ranges": "bytes" });
  });
});

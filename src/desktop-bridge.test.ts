// Guards the LAX_DESKTOP_BRIDGE gate: with the desktop absent, a delete must
// resolve false IMMEDIATELY (caller falls back) and never send a message to a
// non-desktop IPC parent — otherwise every dev/test delete eats the 5s timeout.
// Also guards probeApp's loopback-only invariant: the probe window must never
// be pointed at a non-local URL.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("desktop-bridge", () => {
  const prevFlag = process.env.LAX_DESKTOP_BRIDGE;
  const prevSend = process.send;

  beforeEach(() => { vi.resetModules(); });

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.LAX_DESKTOP_BRIDGE;
    else process.env.LAX_DESKTOP_BRIDGE = prevFlag;
    process.send = prevSend;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is unavailable and resolves false without sending when the desktop flag is unset", async () => {
    delete process.env.LAX_DESKTOP_BRIDGE;
    const send = vi.fn();
    process.send = send as unknown as typeof process.send;
    const { desktopBridgeAvailable, desktopTrashItem } = await import("./desktop-bridge.js");
    expect(desktopBridgeAvailable()).toBe(false);
    expect(await desktopTrashItem("/tmp/whatever")).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves true when main replies ok", async () => {
    process.env.LAX_DESKTOP_BRIDGE = "1";
    const sent: Array<{ type: string; id: number; path: string }> = [];
    process.send = ((m: { type: string; id: number; path: string }) => { sent.push(m); return true; }) as unknown as typeof process.send;
    const onSpy = vi.spyOn(process, "on");
    const { desktopTrashItem } = await import("./desktop-bridge.js");
    const p = desktopTrashItem("/tmp/app");
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("lax:trash-item");
    const listener = onSpy.mock.calls.find((c) => c[0] === "message")![1] as (m: unknown) => void;
    listener({ type: "lax:trash-item-result", id: sent[0].id, ok: true });
    expect(await p).toBe(true);
  });

  it("resolves false when main replies not-ok", async () => {
    process.env.LAX_DESKTOP_BRIDGE = "1";
    const sent: Array<{ id: number }> = [];
    process.send = ((m: { id: number }) => { sent.push(m); return true; }) as unknown as typeof process.send;
    const onSpy = vi.spyOn(process, "on");
    const { desktopTrashItem } = await import("./desktop-bridge.js");
    const p = desktopTrashItem("/tmp/app");
    const listener = onSpy.mock.calls.find((c) => c[0] === "message")![1] as (m: unknown) => void;
    listener({ type: "lax:trash-item-result", id: sent[0].id, ok: false });
    expect(await p).toBe(false);
  });

  it("resolves false on reply timeout (caller falls back)", async () => {
    vi.useFakeTimers();
    process.env.LAX_DESKTOP_BRIDGE = "1";
    process.send = (() => true) as unknown as typeof process.send;
    const { desktopTrashItem } = await import("./desktop-bridge.js");
    const p = desktopTrashItem("/tmp/app");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBe(false);
  });

  it("probeApp resolves null without sending when the bridge is absent (headless)", async () => {
    delete process.env.LAX_DESKTOP_BRIDGE;
    const send = vi.fn();
    process.send = send as unknown as typeof process.send;
    const { probeApp } = await import("./desktop-bridge.js");
    expect(await probeApp("http://127.0.0.1:3000/apps/x")).toBe(null);
    expect(send).not.toHaveBeenCalled();
  });

  it("probeApp resolves null when process.send is unavailable", async () => {
    process.env.LAX_DESKTOP_BRIDGE = "1";
    process.send = undefined;
    const { probeApp } = await import("./desktop-bridge.js");
    expect(await probeApp("http://127.0.0.1:3000/apps/x")).toBe(null);
  });

  it("probeApp rejects non-loopback URLs without sending (invariant)", async () => {
    process.env.LAX_DESKTOP_BRIDGE = "1";
    const send = vi.fn(() => true);
    process.send = send as unknown as typeof process.send;
    const { probeApp } = await import("./desktop-bridge.js");
    expect(await probeApp("https://example.com/app")).toBe(null);
    expect(await probeApp("http://192.168.1.5:3000/apps/x")).toBe(null);
    expect(await probeApp("http://localhost.evil.com:3000/apps/x")).toBe(null);
    // Userinfo bypass: host is evil.com, the loopback text is user:pass. A
    // string-prefix check would wave these through and load a remote origin.
    expect(await probeApp("http://127.0.0.1:80@evil.com/")).toBe(null);
    expect(await probeApp("http://localhost:80@evil.com/")).toBe(null);
    expect(await probeApp("http://127.0.0.1:@evil.com/")).toBe(null);
    // https to a real loopback host is still rejected — app serving is http.
    expect(await probeApp("https://127.0.0.1:3000/apps/x")).toBe(null);
    expect(send).not.toHaveBeenCalled();
  });

  it("isLoopbackAppUrl accepts 127.0.0.1 and localhost; rejects the rest", async () => {
    const { isLoopbackAppUrl } = await import("./desktop-bridge.js");
    expect(isLoopbackAppUrl("http://127.0.0.1:7007/apps/x/index.html")).toBe(true);
    expect(isLoopbackAppUrl("http://localhost:4173/")).toBe(true);
    expect(isLoopbackAppUrl("http://127.0.0.1:80@evil.com/")).toBe(false);
    expect(isLoopbackAppUrl("https://127.0.0.1/")).toBe(false);
    expect(isLoopbackAppUrl("http://127.0.0.1.evil.com/")).toBe(false);
    expect(isLoopbackAppUrl("not a url")).toBe(false);
  });

  it("probeApp round-trips through main and resolves the probe result", async () => {
    process.env.LAX_DESKTOP_BRIDGE = "1";
    const sent: Array<{ type: string; id: number; url: string; timeoutMs: number; wantScreenshot?: boolean }> = [];
    process.send = ((m: { type: string; id: number; url: string; timeoutMs: number; wantScreenshot?: boolean }) => { sent.push(m); return true; }) as unknown as typeof process.send;
    const onSpy = vi.spyOn(process, "on");
    const { probeApp } = await import("./desktop-bridge.js");
    const p = probeApp("http://localhost:4173/", { wantScreenshot: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("lax:probe-app");
    expect(sent[0].url).toBe("http://localhost:4173/");
    expect(sent[0].timeoutMs).toBe(8_000); // default forwarded so main and server agree on the deadline
    expect(sent[0].wantScreenshot).toBe(true);
    const listener = onSpy.mock.calls.find((c) => c[0] === "message")![1] as (m: unknown) => void;
    listener({ type: "lax:probe-app-result", id: sent[0].id, ok: true, booted: true, errors: [{ kind: "console", message: "boom", source: "app.js", line: 7 }] });
    expect(await p).toEqual({ booted: true, errors: [{ kind: "console", message: "boom", source: "app.js", line: 7 }], screenshotB64: undefined });
  });

  it("probeApp resolves null when main reports an internal failure (ok:false)", async () => {
    process.env.LAX_DESKTOP_BRIDGE = "1";
    const sent: Array<{ id: number }> = [];
    process.send = ((m: { id: number }) => { sent.push(m); return true; }) as unknown as typeof process.send;
    const onSpy = vi.spyOn(process, "on");
    const { probeApp } = await import("./desktop-bridge.js");
    const p = probeApp("http://127.0.0.1:4173/");
    const listener = onSpy.mock.calls.find((c) => c[0] === "message")![1] as (m: unknown) => void;
    listener({ type: "lax:probe-app-result", id: sent[0].id, ok: false, booted: false, errors: [], error: "window construction failed" });
    expect(await p).toBe(null);
  });

  it("probeApp resolves null when main never replies (timeout + grace)", async () => {
    vi.useFakeTimers();
    process.env.LAX_DESKTOP_BRIDGE = "1";
    process.send = (() => true) as unknown as typeof process.send;
    const { probeApp } = await import("./desktop-bridge.js");
    const p = probeApp("http://127.0.0.1:4173/", { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(6_000); // 1s load deadline + 5s reply grace
    expect(await p).toBe(null);
  });
});

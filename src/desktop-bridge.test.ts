// Guards the LAX_DESKTOP_BRIDGE gate: with the desktop absent, a delete must
// resolve false IMMEDIATELY (caller falls back) and never send a message to a
// non-desktop IPC parent — otherwise every dev/test delete eats the 5s timeout.

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
});

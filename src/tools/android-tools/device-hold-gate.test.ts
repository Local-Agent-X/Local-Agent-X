// The `android` tool lets one chat's agent drive a device at a time. Another
// chat's driving call comes back as an error it can retry, looking is never
// held back, and a chat's own workers drive for the chat.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adb = vi.hoisted(() => ({
  tap: vi.fn(async () => {}),
  screenshot: vi.fn(async () => Buffer.from("png")),
  resolveSerial: vi.fn(async (serial?: string) => serial ?? "emulator-5554"),
}));
vi.mock("../../android/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../android/index.js")>()),
  checkAndroidSdk: () => ({ sdkRoot: "sdk", hasAdb: true, hasEmulator: true }),
  resolveSerial: adb.resolveSerial,
  tap: adb.tap,
  screenshot: adb.screenshot,
}));

const { createAndroidTools } = await import("./index.js");
const { deviceHoldGate } = await import("./gates.js");
const { deviceHolder } = await import("../../android/index.js");
const { _resetDeviceHoldsForTest } = await import("../../android/device-hold.js");
const { clearSessionOwner, registerChildSessionOwner } = await import("../../browser/session-owner-registry.js");
// The stamp the dispatcher puts on a call's args (tool-execution/internal-args.ts sessionIdOf).
const SESSION_ID_KEY = "_sessionId";

const android = createAndroidTools()[0];
const call = (action: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  android.execute({ action, [SESSION_ID_KEY]: sessionId, ...extra });

beforeEach(() => { _resetDeviceHoldsForTest(); adb.tap.mockClear(); adb.resolveSerial.mockClear(); });
afterEach(() => clearSessionOwner("agent-chunk-1"));

describe("one chat drives a device at a time", () => {
  it("the second chat's tap is refused with who has the device, and never reaches it", async () => {
    expect((await call("tap", "chat-a", { x: 10, y: 20 })).isError).toBeFalsy();
    const refused = await call("tap", "chat-b", { x: 30, y: 40 });
    expect(refused.isError).toBe(true);
    expect(refused.status).toBe("error"); // it can work later: not a policy block
    expect(refused.content).toContain("emulator-5554 is in use by another chat");
    expect(refused.content).toContain("this app tracks and shows one");
    expect(refused.metadata).toMatchObject({ androidStatus: "device-held", heldBy: "chat-a" });
    expect(adb.tap).toHaveBeenCalledTimes(1);
    expect(deviceHolder("emulator-5554")).toBe("chat-a");
  });

  it("looking at the device is never held back", async () => {
    await call("tap", "chat-a", { x: 10, y: 20 });
    expect(await deviceHoldGate("screenshot", { [SESSION_ID_KEY]: "chat-b" })).toBeNull();
    expect(await deviceHoldGate("list_devices", { [SESSION_ID_KEY]: "chat-b" })).toBeNull();
    expect(await deviceHoldGate("list_apps", { [SESSION_ID_KEY]: "chat-b" })).toBeNull();
    // Booting a device drives none yet.
    expect(await deviceHoldGate("start_emulator", { [SESSION_ID_KEY]: "chat-b" })).toBeNull();
  });

  it("a chat's worker drives for the chat: it shares the chat's hold", async () => {
    registerChildSessionOwner("agent-chunk-1", "chat-a");
    expect((await call("tap", "agent-chunk-1", { x: 1, y: 2 })).isError).toBeFalsy();
    expect(deviceHolder("emulator-5554")).toBe("chat-a");
    expect((await call("tap", "chat-a", { x: 3, y: 4 })).isError).toBeFalsy();
    expect((await call("tap", "chat-b", { x: 5, y: 6 })).isError).toBe(true);
  });

  it("a named device is the one held; another stays free", async () => {
    await call("tap", "chat-a", { x: 1, y: 2, device: "emulator-5554" });
    expect((await call("tap", "chat-b", { x: 1, y: 2, device: "emulator-5556" })).isError).toBeFalsy();
  });

  it("with no one device to name, the handler's own error is what comes back", async () => {
    adb.resolveSerial.mockRejectedValue(new Error("No Android device/emulator is connected."));
    try {
      expect(await deviceHoldGate("tap", { [SESSION_ID_KEY]: "chat-a" })).toBeNull();
      expect((await call("tap", "chat-a", { x: 1, y: 2 })).content).toContain("No Android device/emulator is connected");
    } finally {
      adb.resolveSerial.mockImplementation(async (serial?: string) => serial ?? "emulator-5554");
    }
  });
});

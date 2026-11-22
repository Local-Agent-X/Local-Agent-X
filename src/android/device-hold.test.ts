// One chat drives a device at a time: a device is one screen, so two chats'
// agents on it undo each other. The hold follows use and lapses on its own.
import { beforeEach, describe, expect, it } from "vitest";
import { deviceHolder, holdDevice, releaseDevice, HOLD_IDLE_MS, _resetDeviceHoldsForTest } from "./device-hold.js";

beforeEach(() => _resetDeviceHoldsForTest());

describe("holdDevice", () => {
  it("the first chat to drive a device holds it; a second is told who has it", () => {
    expect(holdDevice("emulator-5554", "chat-a", 1_000)).toBeNull();
    expect(holdDevice("emulator-5554", "chat-b", 2_000)).toBe("chat-a");
    expect(deviceHolder("emulator-5554", 2_000)).toBe("chat-a");
    // The holder keeps driving, and each call renews its hold.
    expect(holdDevice("emulator-5554", "chat-a", 3_000)).toBeNull();
  });

  it("is per device: another device is free", () => {
    expect(holdDevice("emulator-5554", "chat-a", 1_000)).toBeNull();
    expect(holdDevice("emulator-5556", "chat-b", 1_000)).toBeNull();
    expect([deviceHolder("emulator-5554", 1_000), deviceHolder("emulator-5556", 1_000)]).toEqual(["chat-a", "chat-b"]);
  });

  it("lapses after the holder stops using the device, counted from its last use", () => {
    holdDevice("emulator-5554", "chat-a", 0);
    holdDevice("emulator-5554", "chat-a", 60_000);
    expect(holdDevice("emulator-5554", "chat-b", 60_000 + HOLD_IDLE_MS - 1)).toBe("chat-a");
    expect(deviceHolder("emulator-5554", 60_000 + HOLD_IDLE_MS)).toBeUndefined();
    expect(holdDevice("emulator-5554", "chat-b", 60_000 + HOLD_IDLE_MS)).toBeNull();
    expect(deviceHolder("emulator-5554", 60_000 + HOLD_IDLE_MS)).toBe("chat-b");
  });

  it("a refused chat does not extend or take the hold", () => {
    holdDevice("emulator-5554", "chat-a", 0);
    holdDevice("emulator-5554", "chat-b", HOLD_IDLE_MS - 1); // refused
    expect(deviceHolder("emulator-5554", HOLD_IDLE_MS)).toBeUndefined();
  });

  it("a device that went away is held by nobody", () => {
    holdDevice("emulator-5554", "chat-a", 0);
    releaseDevice("emulator-5554");
    expect(holdDevice("emulator-5554", "chat-b", 1)).toBeNull();
  });
});

// The feed behind the Android tab runs for any device someone is watching or
// driving, on a lease: a phone over USB shows like an emulator this app
// booted, and a device nobody renews stops being screenshotted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  screenshot: vi.fn(async (_serial: string): Promise<Buffer> => Buffer.from("png")),
  push: vi.fn((_serial: string, _png: Buffer) => true),
}));
vi.mock("./adb.js", () => ({ screenshot: io.screenshot }));
vi.mock("../desktop-bridge.js", () => ({ desktopPushAndroidFrame: io.push }));

const { watchDevice, unwatchDevice, watchedDevices, WATCH_LEASE_MS } = await import("./frame-stream.js");

const PHONE = "R3GLA04C0JK";
const EMULATOR = "emulator-5554";

beforeEach(() => {
  vi.useFakeTimers();
  io.screenshot.mockClear();
  io.push.mockClear();
  io.screenshot.mockImplementation(async () => Buffer.from("png"));
});
afterEach(() => {
  for (const serial of watchedDevices()) unwatchDevice(serial);
  vi.useRealTimers();
});

describe("watching a device", () => {
  it("pushes its first frame at once and keeps them coming", async () => {
    watchDevice(PHONE);
    await vi.advanceTimersByTimeAsync(0);
    expect(io.push).toHaveBeenCalledWith(PHONE, expect.any(Buffer));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(io.push.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("runs one feed per device however often it is renewed", async () => {
    watchDevice(PHONE);
    watchDevice(PHONE);
    watchDevice(EMULATOR);
    expect(watchedDevices().sort()).toEqual([PHONE, EMULATOR].sort());
    await vi.advanceTimersByTimeAsync(0);
    expect(io.screenshot.mock.calls.filter(([serial]) => serial === PHONE)).toHaveLength(1);
  });

  it("stops when nobody has renewed the lease", async () => {
    watchDevice(PHONE);
    await vi.advanceTimersByTimeAsync(WATCH_LEASE_MS + 1_000);
    expect(watchedDevices()).toEqual([]);
    const shots = io.screenshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(io.screenshot.mock.calls.length).toBe(shots);
  });

  it("keeps running while it is renewed", async () => {
    watchDevice(PHONE);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(WATCH_LEASE_MS - 5_000);
      watchDevice(PHONE);
    }
    expect(watchedDevices()).toEqual([PHONE]);
  });

  it("a device that stops answering pushes nothing and lapses with its lease", async () => {
    io.screenshot.mockImplementation(async () => { throw new Error("device offline"); });
    watchDevice(PHONE);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(io.push).not.toHaveBeenCalled();
    expect(watchedDevices()).toEqual([PHONE]);
    await vi.advanceTimersByTimeAsync(WATCH_LEASE_MS);
    expect(watchedDevices()).toEqual([]);
  });

  it("a frame captured for a device that was unwatched meanwhile is dropped", async () => {
    let finish: (png: Buffer) => void = () => {};
    io.screenshot.mockImplementation(() => new Promise<Buffer>((resolve) => { finish = resolve; }));
    watchDevice(EMULATOR);
    unwatchDevice(EMULATOR);
    finish(Buffer.from("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(io.push).not.toHaveBeenCalled();
  });
});

// `LocalAgentX.exe --quit` asks the running instance to quit the way the
// tray's Quit does. A restart from outside used to force-kill the app, which
// skipped every exit step and, with crash reports on, read as a crash.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fake = vi.hoisted(() => ({
  lockFree: true,
  payloads: [] as unknown[],
  quit: 0,
  secondInstance: null as null | ((e: unknown, argv: string[], cwd: string, data: unknown) => void),
}));
vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: (payload: unknown) => { fake.payloads.push(payload); return fake.lockFree; },
    quit: () => { fake.quit++; },
    exit: vi.fn(),
    on: (event: string, fn: never) => { if (event === "second-instance") fake.secondInstance = fn; },
  },
}));
vi.mock("./server-process", () => ({ setQuitting: vi.fn() }));
vi.mock("./window", () => ({ isStuckOnSplash: () => false, showWindow: vi.fn() }));

import { acquireSingleInstance } from "./single-instance";

beforeEach(() => { fake.lockFree = true; fake.payloads = []; fake.quit = 0; fake.secondInstance = null; });

describe("a --quit launch", () => {
  it("signals the running instance and exits without becoming the app", async () => {
    fake.lockFree = false;
    const onQuit = vi.fn();
    expect(await acquireSingleInstance(onQuit, ["LocalAgentX.exe", "--quit"])).toBe(false);
    expect(fake.payloads).toEqual([{ tag: "quit" }]);
    expect(fake.quit).toBe(1);
    expect(fake.secondInstance).toBeNull();
    expect(onQuit).not.toHaveBeenCalled();
  });

  it("with nothing running, just exits", async () => {
    expect(await acquireSingleInstance(vi.fn(), ["LocalAgentX.exe", "--quit"])).toBe(false);
    expect(fake.quit).toBe(1);
  });
});

describe("the running instance", () => {
  it("quits the tray's way when a --quit launch asks, and only then", async () => {
    const onQuit = vi.fn();
    expect(await acquireSingleInstance(onQuit, ["LocalAgentX.exe"])).toBe(true);
    fake.secondInstance!({}, [], "", { tag: "shortcut-relaunch" });
    expect(onQuit).not.toHaveBeenCalled();
    fake.secondInstance!({}, [], "", { tag: "quit" });
    expect(onQuit).toHaveBeenCalledOnce();
  });
});

// Regression guards for two computer-control bugs:
//
//  1. Stuck modifier (keyboard corruption): pressKeys() pressed a chord then
//     released it with no try/finally. If the run aborted between press and
//     release (panic hotkey / crash), the modifier (ctrl/shift/alt/cmd) stayed
//     latched at the OS level and every later real keystroke behaved as a chord.
//     The fix wraps the abort-check in try/finally so release ALWAYS runs.
//
//  2. Multi-monitor aim: getScreenGeometry() must report each monitor's virtual-
//     desktop offset (secondary monitors sit at an offset, often negative) so the
//     agent aims in the same coordinate space screen_capture/move/click use —
//     not the primary-only (0,0)-origin size getScreenSize() returns.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Native nut.js stand-in. pressKey resolves; releaseKey is a spy we assert on.
// checkAbort reads a live `aborted` flag off this signal object.
const pressKey = vi.fn(async () => {});
const releaseKey = vi.fn(async () => {});

vi.mock("@nut-tree-fork/nut-js", () => ({
  mouse: { config: {}, getPosition: vi.fn(async () => ({ x: 0, y: 0 })) },
  keyboard: { config: {}, pressKey, releaseKey, type: vi.fn(async () => {}) },
  screen: { width: vi.fn(async () => 1408), height: vi.fn(async () => 881) },
  Key: { A: 1, LeftControl: 2, LeftShift: 3 },
  Point: class { constructor(public x: number, public y: number) {} },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  straightTo: (p: unknown) => p,
}));

// listMonitors is the canonical multi-monitor enumerator getScreenGeometry reuses.
const listMonitors = vi.fn();
vi.mock("../screen-capture.js", () => ({ listMonitors: () => listMonitors() }));

import { pressKeys, getScreenGeometry, InputUnsupportedError } from "./input-driver.js";

const onWindows = process.platform === "win32";
const onDarwin = process.platform === "darwin";
// Computer control is only wired for macOS + Windows; every real behavior below
// hits assertSupportedOS() first, which throws on Linux (the CI runner). Scope
// the behavior tests to a supported OS and cover the Linux guard separately.
const supported = onWindows || onDarwin;

describe.skipIf(!supported)("pressKeys always releases the chord (no stuck modifier)", () => {
  beforeEach(() => {
    pressKey.mockClear();
    releaseKey.mockClear();
  });

  it("releases even when abort fires between press and release", async () => {
    // Signal is NOT aborted at entry (so the top-of-fn checkAbort passes and
    // pressKey runs), then flips to aborted so the POST-press checkAbort throws
    // — the exact window where a modifier would leak without the finally.
    let reads = 0;
    const signal = { get aborted() { return ++reads > 1; } } as unknown as AbortSignal;
    await expect(pressKeys(["ctrl", "a"], signal)).rejects.toThrow(/aborted/i);
    // The bug: release skipped → modifier latched. The fix: release still ran.
    expect(pressKey).toHaveBeenCalledTimes(1);
    expect(releaseKey).toHaveBeenCalledTimes(1);
    // Released in REVERSE order (a, then ctrl) so the modifier lifts last.
    expect(releaseKey.mock.calls[0]).toEqual([1, 2]); // A=1, LeftControl=2 reversed from [ctrl,a]
  });

  it("releases on the normal (non-aborted) path too", async () => {
    await pressKeys(["ctrl", "a"]);
    expect(pressKey).toHaveBeenCalledTimes(1);
    expect(releaseKey).toHaveBeenCalledTimes(1);
  });
});

describe("getScreenGeometry reports multi-monitor offsets", () => {
  it.skipIf(!onWindows)("carries each monitor's virtual-desktop rect incl. negative offsets", async () => {
    // A left-hand secondary monitor at negative x — the case the agent used to
    // miss (it aimed on the primary at (0,0) and landed on the wrong screen).
    listMonitors.mockReturnValue([
      { index: 0, name: "Primary", x: 0, y: 0, width: 1920, height: 1080, primary: true },
      { index: 1, name: "Left", x: -1920, y: 0, width: 1920, height: 1080, primary: false },
    ]);
    const geo = await getScreenGeometry();
    expect(geo.monitors).toHaveLength(2);
    expect(geo.primary.index).toBe(0);
    // Virtual desktop spans both: from x=-1920 to x=1920 → width 3840.
    expect(geo.virtual).toEqual({ x: -1920, y: 0, width: 3840, height: 1080 });
    // The secondary keeps its negative origin — that's what move/click need.
    expect(geo.monitors.find((m) => m.index === 1)!.x).toBe(-1920);
  });

  // darwin is the only non-Windows OS that supports computer control; on Linux
  // getScreenGeometry throws InputUnsupportedError (covered below), so this
  // single-primary path is macOS-only, not merely "not Windows".
  it.skipIf(!onDarwin)("macOS: single primary from nut.js size", async () => {
    const geo = await getScreenGeometry();
    expect(geo.monitors).toHaveLength(1);
    expect(geo.virtual).toEqual({ x: 0, y: 0, width: 1408, height: 881 });
    expect(geo.primary.primary).toBe(true);
  });
});

// On an unsupported OS (e.g. the Linux CI runner) every entry point must refuse
// up front rather than attempt native input — this is the guard the behavior
// tests above rely on to be scoped correctly.
describe.skipIf(supported)("unsupported OS refuses computer control", () => {
  it("pressKeys throws InputUnsupportedError", async () => {
    await expect(pressKeys(["ctrl", "a"])).rejects.toThrow(InputUnsupportedError);
  });

  it("getScreenGeometry throws InputUnsupportedError", async () => {
    await expect(getScreenGeometry()).rejects.toThrow(InputUnsupportedError);
  });
});

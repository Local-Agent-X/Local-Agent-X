// Regression guard for the remote-control coordinate bug: a phone tap landed
// down-and-right of the target because listMonitors() has no macOS/Linux
// implementation and returned a bogus 1920x1080, which the desktop then mapped
// onto before injecting into nut.js's REAL (smaller) point space. The fix
// sources the rect from nut.js getScreenSize() — the exact space injection uses
// — on non-Windows. These tests pin that: reported size must be the real screen,
// and a normalized tap must land at the matching desktop point (no drift).

import { describe, it, expect, vi, beforeEach } from "vitest";

// enableRemoteControl defaults to false (kill-switch); arm it so the pump injects.
vi.mock("../config.js", () => ({
  getRuntimeConfig: () => ({ enableRemoteControl: true }),
}));

// Stand in for the native nut.js driver. getScreenSize returns a screen whose
// size/aspect differ from the old 1920x1080 fallback, so a regression to the
// fallback would change the asserted numbers.
vi.mock("../tools/input-driver.js", () => ({
  getScreenSize: vi.fn(async () => ({ width: 1408, height: 881 })),
  setMousePosition: vi.fn(async () => {}),
  getMousePosition: vi.fn(async () => ({ x: 0, y: 0 })),
  clickMouse: vi.fn(async () => {}),
  pressButton: vi.fn(async () => {}),
  releaseButton: vi.fn(async () => {}),
  scroll: vi.fn(async () => {}),
  typeText: vi.fn(async () => {}),
  pressKeys: vi.fn(async () => {}),
}));

import { describeDisplays, ScreenInputController } from "./screen-input.js";
import { setMousePosition, getScreenSize } from "../tools/input-driver.js";

// On Windows the rect comes from the real listMonitors() instead, so these
// nut.js-sourced assertions only apply off-Windows.
const onWindows = process.platform === "win32";

describe("screen-input maps onto the real injection-space screen size", () => {
  beforeEach(() => {
    vi.mocked(setMousePosition).mockClear();
    vi.mocked(getScreenSize).mockClear();
  });

  it.skipIf(onWindows)("describeDisplays reports the nut.js screen size, not the 1920x1080 fallback", async () => {
    const d = await describeDisplays();
    expect(d).toEqual({ count: 1, active: 0, width: 1408, height: 881 });
  });

  it.skipIf(onWindows)("a centre tap lands at the screen centre (no down-right drift)", async () => {
    const c = new ScreenInputController(undefined, () => {});
    c.enqueue({ kind: "move", x: 0.5, y: 0.5 });
    await vi.waitFor(() => expect(setMousePosition).toHaveBeenCalled());
    expect(vi.mocked(setMousePosition).mock.calls[0]).toEqual([704, 440.5]);
  });

  it.skipIf(onWindows)("the far corner maps to the far corner, not past it", async () => {
    const c = new ScreenInputController(undefined, () => {});
    c.enqueue({ kind: "move", x: 1, y: 1 });
    await vi.waitFor(() => expect(setMousePosition).toHaveBeenCalled());
    expect(vi.mocked(setMousePosition).mock.calls[0]).toEqual([1408, 881]);
  });

  it.skipIf(onWindows)("re-resolves the rect after a monitor switch", async () => {
    const c = new ScreenInputController(undefined, () => {});
    c.enqueue({ kind: "move", x: 0.5, y: 0.5 });
    await vi.waitFor(() => expect(setMousePosition).toHaveBeenCalled());
    expect(getScreenSize).toHaveBeenCalledTimes(1); // resolved + cached

    c.setMonitor(1); // invalidates the cached rect
    c.enqueue({ kind: "move", x: 0.5, y: 0.5 });
    await vi.waitFor(() => expect(vi.mocked(setMousePosition).mock.calls.length).toBe(2));
    expect(getScreenSize).toHaveBeenCalledTimes(2); // re-resolved, not stale
  });
});

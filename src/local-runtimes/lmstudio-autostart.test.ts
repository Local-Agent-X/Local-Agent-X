import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  maybeAutostartLmStudio,
  lmStudioAutoStartedAt,
  resetLmStudioAutostart,
  type LmStudioAutostartDeps,
} from "./lmstudio-autostart.js";
import type { LocalRuntimeInfo } from "./types.js";

function deps(overrides: Partial<LmStudioAutostartDeps> = {}): LmStudioAutostartDeps {
  return {
    isLmStudioRunning: vi.fn(async () => true),
    lmsCliPath: vi.fn(() => "C:\\Users\\u\\.lmstudio\\bin\\lms.exe"),
    startServer: vi.fn(async () => true),
    ...overrides,
  };
}

function runtime(label: string): LocalRuntimeInfo {
  return {
    kind: "openai-compat",
    id: `openai-compat@127.0.0.1:1234`,
    label,
    endpoint: { baseUrl: "http://127.0.0.1:1234", origin: "auto" },
    chatBaseUrl: "http://127.0.0.1:1234/v1",
    models: [],
    refreshedAt: 0,
  };
}

beforeEach(() => resetLmStudioAutostart());

describe("maybeAutostartLmStudio", () => {
  it("starts the server when app is running, CLI exists, and the sweep missed it", async () => {
    const d = deps();
    let t = 1_000_000;
    expect(await maybeAutostartLmStudio([], d, () => t)).toBe(true);
    expect(d.startServer).toHaveBeenCalledOnce();
    expect(lmStudioAutoStartedAt()).toBe(t);
  });

  it("no-op when the sweep already found LM Studio", async () => {
    const d = deps();
    expect(await maybeAutostartLmStudio([runtime("LM Studio")], d, () => 1)).toBe(false);
    expect(d.lmsCliPath).not.toHaveBeenCalled();
    expect(d.startServer).not.toHaveBeenCalled();
  });

  it("a different openai-compat runtime (vLLM) does NOT suppress the start", async () => {
    const d = deps();
    expect(await maybeAutostartLmStudio([runtime("vLLM")], d, () => 1_000_000)).toBe(true);
  });

  it("no-op when the lms CLI is not installed", async () => {
    const d = deps({ lmsCliPath: vi.fn(() => null) });
    expect(await maybeAutostartLmStudio([], d, () => 1_000_000)).toBe(false);
    expect(d.startServer).not.toHaveBeenCalled();
  });

  it("never launches LM Studio itself — app not running means no-op", async () => {
    const d = deps({ isLmStudioRunning: vi.fn(async () => false) });
    expect(await maybeAutostartLmStudio([], d, () => 1_000_000)).toBe(false);
    expect(d.startServer).not.toHaveBeenCalled();
  });

  it("throttles: a second attempt inside the interval is skipped, after it retries", async () => {
    const d = deps({ startServer: vi.fn(async () => false) });
    let t = 1_000_000;
    expect(await maybeAutostartLmStudio([], d, () => t)).toBe(false);
    t += 60_000; // next sweep, still inside the 5-min window
    expect(await maybeAutostartLmStudio([], d, () => t)).toBe(false);
    expect(d.startServer).toHaveBeenCalledOnce();
    t += 5 * 60_000;
    await maybeAutostartLmStudio([], d, () => t);
    expect(d.startServer).toHaveBeenCalledTimes(2);
  });

  it("startServer failure → false, startedAt stays null", async () => {
    const d = deps({ startServer: vi.fn(async () => false) });
    expect(await maybeAutostartLmStudio([], d, () => 1_000_000)).toBe(false);
    expect(lmStudioAutoStartedAt()).toBeNull();
  });

  it("default-deps path is inert under the test runner (no process spawns)", async () => {
    // VITEST is set in this environment; the real-deps path must bail
    // before touching tasklist/pgrep/lms.
    expect(await maybeAutostartLmStudio([])).toBe(false);
  });
});

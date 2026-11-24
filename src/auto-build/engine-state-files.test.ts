import { describe, expect, it } from "vitest";
import { ENGINE_STATE_PATTERNS, isEngineStateEntry } from "./engine-state-files.js";
import { STATE_FILENAME as HALT_HISTORY } from "./failure-recovery.js";
import { ORCHESTRATOR_STATE_FILENAME } from "./orchestrator/state.js";

describe("the build engine's own files beside a project", () => {
  it("cover the run record and halt history the engine writes", () => {
    expect(isEngineStateEntry(ORCHESTRATOR_STATE_FILENAME, false)).toBe(true);
    expect(isEngineStateEntry(HALT_HISTORY, false)).toBe(true);
    expect(isEngineStateEntry(".lax-preflight-sentinel.txt", false)).toBe(true);
    expect(isEngineStateEntry(".primal-orchestrator-state.json", false)).toBe(true);
  });

  it("a folder pattern matches a folder only, a file pattern a file only", () => {
    expect(isEngineStateEntry(".skeptic", true)).toBe(true);
    expect(isEngineStateEntry(".skeptic", false)).toBe(false);
    expect(isEngineStateEntry(".lax-build-run.json", true)).toBe(false);
  });

  it("leave the project's own files alone", () => {
    for (const name of [".lax-launch.json", ".env", "google-services.json", "x.lax-build-run.json", ".lax-build-run.json.bak"]) {
      expect(isEngineStateEntry(name, false), name).toBe(false);
    }
  });

  it("are written as gitignore patterns", () => {
    for (const p of ENGINE_STATE_PATTERNS) expect(p).toMatch(/^\.[\w.*-]+\/?$/);
  });
});

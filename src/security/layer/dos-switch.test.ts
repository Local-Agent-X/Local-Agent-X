/**
 * The shell path guard's deliberate false block on an unshielded Windows switch
 * (`rd /s /q x`) must say what it is. Reported as a path outside the boundary, a
 * model told the user that a folder inside the workspace was outside it (both local
 * models, `restraint-shell-wipe-rd`, 2026-09-26). The block itself is unchanged.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dosSwitchBlockReason } from "./dos-switch.js";
import { evaluateShellPaths } from "./shell-path-guard.js";

const WORKSPACE = join(realpathSync(mkdtempSync(join(tmpdir(), "lax-dos-"))), "workspace");
mkdirSync(join(WORKSPACE, "client-data", "build-cache"), { recursive: true });
const ctx = { workspace: WORKSPACE, fileAccessMode: "workspace" as const, allowedPathCheck: () => false };
const onWindows = process.platform === "win32";

describe("dosSwitchBlockReason", () => {
  it.runIf(onWindows)("names a switch-shaped token as a probable switch and points deletes at delete_file", () => {
    const reason = dosSwitchBlockReason("/s", "workspace")!;
    expect(reason).toMatch(/nothing ran/i);
    expect(reason).toMatch(/Windows switch/);
    expect(reason).toMatch(/delete_file/);
  });

  it("is null for a real path, a relative path, and on every non-Windows platform", () => {
    expect(dosSwitchBlockReason("/etc/passwd", "workspace")).toBeNull();
    expect(dosSwitchBlockReason("client-data", "workspace")).toBeNull();
    if (!onWindows) expect(dosSwitchBlockReason("/s", "workspace")).toBeNull();
  });
});

describe("evaluateShellPaths — which refusal a blocked command gets (win32)", () => {
  it.runIf(onWindows)("rd /s /q on a workspace folder: still blocked, told it is a switch, not an outside path", () => {
    const d = evaluateShellPaths("rd /s /q client-data\\build-cache", ctx);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Windows switch/);
    expect(d.reason).not.toMatch(/touches "\/s" outside/);
  });

  it.runIf(onWindows)("a real outside path in the same command is reported as that path, never as a switch", () => {
    const d = evaluateShellPaths("del /q /etc/shadow", ctx);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/touches "\/etc\/shadow" outside/);
    expect(d.reason).not.toMatch(/Windows switch/);
  });
});

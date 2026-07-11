import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFileAccessModeAtLeast } from "./security-config.js";

// loadFileAccessModeAtLeast is what the subsystem agents (cron, build-app,
// autopilot, self-edit) use so they HONOR the user's global file-access setting
// instead of a hardcoded literal — while never dropping below the floor they
// need to function. The user's setting lives in <LAX_DATA_DIR>/security.json.
describe("loadFileAccessModeAtLeast — subsystems honor the global setting, floored", () => {
  let dir: string;
  const prev = process.env.LAX_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-cfg-"));
    process.env.LAX_DATA_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  const setMode = (mode: string) =>
    writeFileSync(join(dir, "security.json"), JSON.stringify({ fileAccessMode: mode }));

  it("returns the user's mode when it is AT or ABOVE the floor", () => {
    setMode("unrestricted");
    expect(loadFileAccessModeAtLeast("common")).toBe("unrestricted");   // the reported case: scheduled/autopilot inherit full access
    expect(loadFileAccessModeAtLeast("workspace")).toBe("unrestricted");
    setMode("common");
    expect(loadFileAccessModeAtLeast("common")).toBe("common");
    expect(loadFileAccessModeAtLeast("workspace")).toBe("common");
  });

  it("floors up when the user's mode is BELOW the subsystem's minimum (no regression)", () => {
    setMode("workspace");
    expect(loadFileAccessModeAtLeast("common")).toBe("common");          // build-app still reads user assets even if user is on workspace
    expect(loadFileAccessModeAtLeast("workspace")).toBe("workspace");    // cron floor is the global minimum → just inherits
  });

  it("defaults to unrestricted (fresh install) when no config is present", () => {
    // No security.json written → loadFileAccessMode() default is unrestricted.
    expect(loadFileAccessModeAtLeast("common")).toBe("unrestricted");
  });
});

// programOnPath: whether a shell command could run a program, as the
// build-verify gate asks before running a toolchain's check.
import { describe, expect, it } from "vitest";
import { delimiter, join } from "node:path";
import { programOnPath } from "./shell-path.js";

describe("programOnPath", () => {
  const dirs = [join("/opt", "a"), join("/opt", "b")];
  const pathValue = ["", ...dirs].join(delimiter);

  it("finds a program in any PATH directory, under its name or (Windows) a PATHEXT extension", () => {
    const file = process.platform === "win32" ? join(dirs[1], "dotnet.EXE") : join(dirs[1], "dotnet");
    expect(programOnPath("dotnet", pathValue, (p) => p === file)).toBe(true);
  });

  it("is false when no directory holds it, and never matches an empty PATH entry", () => {
    expect(programOnPath("swift", pathValue, () => false)).toBe(false);
    expect(programOnPath("swift", "", (p) => p === "swift")).toBe(false);
  });
});

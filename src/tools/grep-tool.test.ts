import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePattern, ripgrepBin, runRg, type ExecFileLike } from "./grep-tool.js";

// The Node fallback used `new RegExp(pattern)` directly, which throws "Invalid
// group" on ripgrep/PCRE inline flags like `(?i)` — so a case-insensitive
// search that works under rg died whenever rg was absent. parsePattern lifts a
// leading inline-flag group into real RegExp flags so the two paths agree.
describe("grep parsePattern — inline-flag tolerance", () => {
  it("lifts a leading (?i) into the i flag", () => {
    expect(parsePattern("(?i)tailnet", false)).toEqual({ source: "tailnet", flags: "i" });
  });

  it("lifts combined leading flags (?is)", () => {
    const { source, flags } = parsePattern("(?is)foo.bar", false);
    expect(source).toBe("foo.bar");
    expect(flags.split("").sort().join("")).toBe("is");
  });

  it("merges (?i) with the case_insensitive option without duplicating", () => {
    expect(parsePattern("(?i)x", true)).toEqual({ source: "x", flags: "i" });
  });

  it("adds i from the case_insensitive option alone", () => {
    expect(parsePattern("plain", true)).toEqual({ source: "plain", flags: "i" });
  });

  it("leaves a flag-less pattern untouched", () => {
    expect(parsePattern("tailnet|tailscale", false)).toEqual({ source: "tailnet|tailscale", flags: "" });
  });

  it("only strips a LEADING group — a mid-pattern (?i) is left for the graceful-error path", () => {
    expect(parsePattern("foo(?i)bar", false)).toEqual({ source: "foo(?i)bar", flags: "" });
  });

  it("produces a regex that actually matches — the exact pattern that crashed the LAX run", () => {
    const { source, flags } = parsePattern("(?i)tailscale|tailnet", false);
    const re = new RegExp(source, flags); // before the fix, `new RegExp("(?i)...")` threw here
    expect(re.test("make sure both devices are on the same Tailscale network")).toBe(true);
    expect(re.test("the old TAILNET path")).toBe(true);
    expect(re.test("broker only")).toBe(false);
  });
});

// A real rg failure (exit 2 = bad regex / unreadable path) with empty stdout
// used to be silently reported as "No matches found." — hiding the error from
// the model. runRg now discriminates rg's exit codes: only genuine exit-1
// no-matches rounds down to the empty result; every other failure surfaces
// through the tool's error envelope.
describe("grep runRg — ripgrep exit-code discrimination", () => {
  /** Build a stub exec that invokes the callback with the given error/streams. */
  function stubExec(error: (Error & { code?: number | string | null }) | null, stdout = "", stderr = ""): ExecFileLike {
    return (_file, _args, _options, callback) => {
      queueMicrotask(() => callback(error, stdout, stderr));
      return { stdin: { end() {} } };
    };
  }

  it("surfaces an exit-2 failure (empty stdout) as an ERROR, not 'No matches found.'", async () => {
    const error = Object.assign(new Error("rg exited 2"), { code: 2 });
    const res = await runRg({ pattern: "(" }, 250, undefined, stubExec(error, "", "regex parse error: unclosed group"));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("grep failed");
    expect(res.content).toContain("regex parse error");
    expect(res.content).not.toContain("No matches found.");
  });

  it("surfaces a non-ENOENT errno (e.g. EACCES) as an ERROR", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const res = await runRg({ pattern: "x" }, 250, undefined, stubExec(error, ""));
    expect(res.isError).toBe(true);
    expect(res.content).toContain("grep failed");
  });

  it("still returns the no-matches result on a genuine exit-1 (empty stdout)", async () => {
    const error = Object.assign(new Error("no matches"), { code: 1 });
    const res = await runRg({ pattern: "x" }, 250, undefined, stubExec(error, ""));
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("No matches found.");
  });

  it("returns matches on exit 0", async () => {
    const res = await runRg({ pattern: "x" }, 250, undefined, stubExec(null, "a.ts\nb.ts\n"));
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("a.ts\nb.ts");
  });

  it("returns partial matches with a warning when exit 2 arrives WITH stdout (unreadable subdir)", async () => {
    // rg exits 2 whenever ANY error occurred during the search — even with
    // real matches printed (e.g. one chmod-000 subdirectory in an otherwise
    // searchable tree). Partial results must come back, not an error.
    const error = Object.assign(new Error("rg exited 2"), { code: 2 });
    const res = await runRg(
      { pattern: "needle" }, 250, undefined,
      stubExec(error, "tree/readable/hit.ts\n", "tree/locked: Permission denied (os error 13)"),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("tree/readable/hit.ts");
    expect(res.content).toContain("some paths could not be searched");
    expect(res.content).toContain("Permission denied");
  });

  it("returns partial output (not an error) when rg output overflows the buffer cap", async () => {
    const error = Object.assign(new Error("stdout maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    const res = await runRg({ pattern: "x" }, 250, undefined, stubExec(error, "hit-a.ts\nhit-b.ts"));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("hit-a.ts");
    expect(res.content).toContain("TRUNCATED");
  });

  it("rejects on ENOENT so the caller falls through to the Node search", async () => {
    const error = Object.assign(new Error("rg not found"), { code: "ENOENT" });
    await expect(runRg({ pattern: "x" }, 250, undefined, stubExec(error, ""))).rejects.toThrow();
  });
});

describe("ripgrepBin — binary resolution", () => {
  const ORIG = process.env.LAX_BUNDLED_BIN_DIR;
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  // @vscode/ripgrep is a root dependency, so node_modules holds the per-OS
  // binary in CI and dev — the no-bundle tiers resolve to it, not bare `rg`.
  const VSCODE_RG = /@vscode[/\\]ripgrep.*[/\\]bin[/\\]rg(\.exe)?$/;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.LAX_BUNDLED_BIN_DIR;
    else process.env.LAX_BUNDLED_BIN_DIR = ORIG;
  });

  it("prefers the .app-bundled binary when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "rgbin-"));
    const p = join(dir, exe);
    writeFileSync(p, "#!/bin/sh\n");
    process.env.LAX_BUNDLED_BIN_DIR = dir;
    expect(ripgrepBin()).toBe(p);
  });

  it("falls to the @vscode/ripgrep node_modules binary when there's no .app bundle", () => {
    delete process.env.LAX_BUNDLED_BIN_DIR;
    expect(ripgrepBin()).toMatch(VSCODE_RG);
  });

  it("skips a bundle dir that lacks the binary, falling to node_modules", () => {
    process.env.LAX_BUNDLED_BIN_DIR = mkdtempSync(join(tmpdir(), "rgempty-"));
    expect(ripgrepBin()).toMatch(VSCODE_RG);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fallbackSearch, parsePattern, ripgrepBin, runRg, type ExecFileLike } from "./grep-tool.js";
import { parseStatusHeader, renderToolResultForModel } from "./result-helpers.js";

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

// A pattern that BEGINS with a dash — e.g. a CSS custom-property search like
// `--(color|brand)` — used to be pushed as a bare positional arg, so ripgrep
// parsed it as a flag and died with "unrecognized flag" (exit 2). buildRgArgs
// now terminates option parsing with `--` before the pattern/path positionals.
describe("grep — dash-leading patterns are never parsed as flags", () => {
  it("places `--` before the pattern and search root", async () => {
    let seen: readonly string[] = [];
    const exec: ExecFileLike = (_file, args, _options, callback) => {
      seen = args;
      queueMicrotask(() => callback(null, "ok.ts:1:--color", ""));
      return { stdin: { end() {} } };
    };
    await runRg({ pattern: "--(color|brand)", path: tmpdir() }, 250, undefined, exec);
    const sep = seen.indexOf("--");
    expect(sep).toBeGreaterThanOrEqual(0);
    expect(seen.slice(sep + 1)).toHaveLength(2);
    expect(seen[sep + 1]).toBe("--(color|brand)");
  });

  it("finds dash-leading content with the real ripgrep binary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashpat-"));
    writeFileSync(join(dir, "theme.css"), ":root {\n  --color-brand: #fff;\n}\n");
    const res = await runRg({ pattern: "--(color|brand)", path: dir, output_mode: "content" }, 250);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("--color-brand");
  });
});

/** Build a stub exec that invokes the callback with the given error/streams. */
function stubExec(error: (Error & { code?: number | string | null }) | null, stdout = "", stderr = ""): ExecFileLike {
  return (_file, _args, _options, callback) => {
    queueMicrotask(() => callback(error, stdout, stderr));
    return { stdin: { end() {} } };
  };
}

/** The skeptic's count-inflation fixture: one real match buried in timestamped
 *  log lines whose `10:15:0N` text looks exactly like a `:N:` match locator. */
function makeTimestampedLog(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "greplog-"));
  const file = join(dir, "app.log");
  writeFileSync(file, [
    "10:15:01 boot",
    "10:15:02 warm",
    "10:15:03 steady",
    "ERROR needle exploded",
    "10:15:05 recover",
    "10:15:06 done",
  ].join("\n") + "\n");
  return { dir, file };
}

/** Hostile parity tree: the timestamped log (match within context-distance of
 *  EOF), a multi-block text file, and a binary file whose BYTES contain the
 *  pattern (rg suppresses it during traversal — verified empirically). */
function makeHostileTree(): string {
  const { dir } = makeTimestampedLog();
  const sample: string[] = [];
  for (let i = 1; i <= 30; i++) sample.push(i === 5 || i === 25 ? `needle line ${i}` : `filler line ${i}`);
  writeFileSync(join(dir, "sample.txt"), sample.join("\n") + "\n");
  // "needle" followed by NUL/control/0xFF bytes.
  writeFileSync(join(dir, "blob.bin"), new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01, 0xff, 0x00]));
  return dir;
}

/** Split rendered content-mode output into its `--`-separated blocks, sorted —
 *  the shape parity CAN guarantee, since rg's multi-file order is unspecified. */
function sortedBlocks(body: string): string[] {
  const blocks: string[][] = [[]];
  for (const line of body.split("\n")) {
    if (line === "--") blocks.push([]);
    else blocks[blocks.length - 1].push(line);
  }
  return blocks.map((b) => b.join("\n")).sort();
}

// grep used to define PRIVATE ok/err helpers that shadowed result-helpers.ts,
// so every result was a bare {content} with no envelope. The dispatcher
// recovers status by parsing the rendered header (parseStatusHeader), so grep
// FAILURES rendered headerless and were recorded as "ok" by every status-keyed
// middleware. These tests drive the full seam: build a result, render it for
// the model, re-parse the header.
describe("grep — result envelope survives the render/parse seam", () => {
  it("a ripgrep failure renders an [error] header that parseStatusHeader recovers", async () => {
    const error = Object.assign(new Error("rg exited 2"), { code: 2 });
    const res = await runRg({ pattern: "(" }, 250, undefined, stubExec(error, "", "regex parse error: unclosed group"));
    const rendered = renderToolResultForModel(res);
    expect(parseStatusHeader(rendered)).toBe("error"); // was "ok" with the shadowed private helpers
    expect(rendered).toContain("grep failed");
  });

  it("a fallback invalid-regex failure is status-recoverable too", async () => {
    const res = await fallbackSearch({ pattern: "(" }, 250);
    expect(res.isError).toBe(true);
    expect(parseStatusHeader(renderToolResultForModel(res))).toBe("error");
  });

  it("a success carries pattern/mode/file_count metadata and an [ok] header", async () => {
    const res = await runRg({ pattern: "x" }, 250, undefined, stubExec(null, "a.ts\nb.ts\n"));
    expect(res.status).toBe("ok");
    expect(res.metadata).toMatchObject({ pattern: "x", mode: "files_with_matches", file_count: 2 });
    const rendered = renderToolResultForModel(res);
    expect(parseStatusHeader(rendered)).toBe("ok");
    expect(rendered).toContain("a.ts\nb.ts");
  });

  it("the zero-match sentinel renders VERBATIM — anchored consumers (isEmptyGrepResult, EMPTY_RESULT_RE) match the rendered content from position 0", async () => {
    const error = Object.assign(new Error("no matches"), { code: 1 });
    const res = await runRg({ pattern: "x" }, 250, undefined, stubExec(error, ""));
    const rendered = renderToolResultForModel(res);
    expect(rendered).toBe("No matches found.");
    expect(parseStatusHeader(rendered)).toBe("ok");
  });
});

// One grep call should answer "where AND what": content mode now defaults to
// 4 lines of surrounding context so the model doesn't spend a follow-up read
// round trip per hit file. files_with_matches and count are unchanged.
describe("grep — content mode defaults to 4 lines of context (rg args)", () => {
  async function rgArgsFor(input: Record<string, unknown>): Promise<readonly string[]> {
    let seen: readonly string[] = [];
    const exec: ExecFileLike = (_file, args, _options, callback) => {
      seen = args;
      queueMicrotask(() => callback(null, "", ""));
      return { stdin: { end() {} } };
    };
    await runRg(input, 250, undefined, exec);
    return seen;
  }

  it("content mode without context gets -C 4", async () => {
    const args = await rgArgsFor({ pattern: "x", output_mode: "content" });
    const i = args.indexOf("-C");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("4");
  });

  it("an explicit context is respected", async () => {
    const args = await rgArgsFor({ pattern: "x", output_mode: "content", context: 2 });
    expect(args[args.indexOf("-C") + 1]).toBe("2");
  });

  it("an explicit context of 0 omits -C entirely (bare match lines)", async () => {
    const args = await rgArgsFor({ pattern: "x", output_mode: "content", context: 0 });
    expect(args.indexOf("-C")).toBe(-1);
    expect(args).toContain("-n");
  });

  it("files_with_matches and count modes never get -C", async () => {
    expect((await rgArgsFor({ pattern: "x" })).indexOf("-C")).toBe(-1);
    expect((await rgArgsFor({ pattern: "x", output_mode: "count" })).indexOf("-C")).toBe(-1);
  });
});

describe("grep fallbackSearch — default context, block merging, rg parity", () => {
  /** 30 lines with matches at 5 and 25 → two well-separated context blocks. */
  function makeTree(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "grepctx-"));
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(i === 5 || i === 25 ? `needle line ${i}` : `filler line ${i}`);
    const file = join(dir, "sample.txt");
    writeFileSync(file, lines.join("\n") + "\n");
    return { dir, file };
  }

  it("applies the 4-line default: ':' on match lines, '-' on context lines, '--' between blocks", async () => {
    const { dir, file } = makeTree();
    const res = await fallbackSearch({ pattern: "needle", path: dir, output_mode: "content" }, 250);
    const out = res.content.split("\n");
    expect(out).toContain(`${file}:5:needle line 5`);
    expect(out).toContain(`${file}-4-filler line 4`);
    expect(out).toContain(`${file}-9-filler line 9`);
    expect(out).toContain(`${file}:25:needle line 25`);
    expect(out.filter((l) => l === "--")).toHaveLength(1);
    expect(res.metadata).toMatchObject({ mode: "content", match_count: 2 });
  });

  it("an explicit context of 0 restores bare match lines with no separators", async () => {
    const { dir, file } = makeTree();
    const res = await fallbackSearch({ pattern: "needle", path: dir, output_mode: "content", context: 0 }, 250);
    expect(res.content.split("\n")).toEqual([
      `${file}:5:needle line 5`,
      `${file}:25:needle line 25`,
    ]);
  });

  it("overlapping context windows merge into one block with no duplicate lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grepmerge-"));
    const lines: string[] = [];
    for (let i = 1; i <= 12; i++) lines.push(i === 5 || i === 7 ? `needle line ${i}` : `filler line ${i}`);
    writeFileSync(join(dir, "close.txt"), lines.join("\n") + "\n");
    const res = await fallbackSearch({ pattern: "needle", path: dir, output_mode: "content" }, 250);
    const out = res.content.split("\n");
    expect(out.filter((l) => l === "--")).toHaveLength(0);
    expect(new Set(out).size).toBe(out.length); // pre-merge, the shared context lines printed twice
    expect(out).toHaveLength(11); // lines 1..11 as one block
  });

  it("matches real ripgrep block-for-block on a hostile tree (EOF-adjacent match, timestamped context, binary file)", async () => {
    const dir = makeHostileTree();
    const args = { pattern: "needle", path: dir, output_mode: "content" };
    const rg = await runRg(args, 250);
    const fb = await fallbackSearch(args, 250);
    expect(rg.isError).toBeFalsy();
    // rg's multi-file ORDER is unspecified under its parallel walk (observed
    // non-alphabetical on this very fixture), so parity is asserted on the
    // set of context blocks — the guaranteed content — not global byte order.
    expect(sortedBlocks(fb.content)).toEqual(sortedBlocks(rg.content));
    // The binary file matches the pattern byte-wise; both paths must suppress
    // it entirely (rg verified empirically; the fallback NUL-guards).
    expect(fb.content).not.toContain("\0");
    expect(fb.content).not.toContain("blob.bin");
    expect(rg.content).not.toContain("blob.bin");
    // Exact counts on both paths: 1 in app.log + 2 in sample.txt.
    expect(fb.metadata?.match_count).toBe(3);
    expect(rg.metadata?.match_count).toBe(3);
  });

  it("head_limit still caps total output and flags metadata.truncated", async () => {
    const { dir } = makeTree();
    const res = await fallbackSearch({ pattern: "needle", path: dir, output_mode: "content" }, 5);
    expect(res.content).toContain("more lines)");
    expect(res.metadata?.truncated).toBe(true);
  });

  it("files_with_matches mode is unchanged by the content-mode default", async () => {
    const { dir, file } = makeTree();
    const res = await fallbackSearch({ pattern: "needle", path: dir }, 250);
    expect(res.content).toBe(file);
    expect(res.metadata).toMatchObject({ mode: "files_with_matches", file_count: 1 });
  });
});

// Skeptic repro (defect 1): match_count was regex-derived from RENDERED lines,
// so context lines with `:N:`-shaped text (timestamps, stack traces) inflated
// it — one real match among "10:15:0N" lines counted as 5. Both paths must now
// report the exact count from match data, never from the rendering.
describe("grep — match_count is exact, never inflated by context text", () => {
  it("fallback: one match among timestamped context lines → match_count exactly 1", async () => {
    const { dir } = makeTimestampedLog();
    const res = await fallbackSearch({ pattern: "needle", path: dir, output_mode: "content" }, 250);
    expect(res.metadata?.match_count).toBe(1);
  });

  it("rg path (real binary): same fixture → match_count exactly 1", async () => {
    const { dir } = makeTimestampedLog();
    const res = await runRg({ pattern: "needle", path: dir, output_mode: "content" }, 250);
    expect(res.isError).toBeFalsy();
    expect(res.metadata?.match_count).toBe(1);
  });

  it("rg path gets the count from a second `-c` pass with the same pattern/filters, not the rendered lines", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: ExecFileLike = (_file, a, _options, callback) => {
      calls.push(a);
      const stdout = a.includes("-c")
        ? "C:\\logs\\app.log:1"
        : [
            "C:\\logs\\app.log-3-10:15:03 steady",
            "C:\\logs\\app.log:4:ERROR needle exploded",
            "C:\\logs\\app.log-5-10:15:05 recover",
          ].join("\n");
      queueMicrotask(() => callback(null, stdout, ""));
      return { stdin: { end() {} } };
    };
    const res = await runRg({ pattern: "needle", output_mode: "content", glob: "*.log" }, 250, undefined, exec);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("-c");
    expect(calls[1]).toContain("--glob"); // count pass carries the same filters
    expect(calls[1]).not.toContain("-C");
    // A regex over the rendered lines would say 3 here (every line embeds
    // `:NN:`); the -c pass says 1.
    expect(res.metadata?.match_count).toBe(1);
  });

  it("explicit context 0 needs no second pass — every rendered line is a match line", async () => {
    const calls: Array<readonly string[]> = [];
    const exec: ExecFileLike = (_file, a, _options, callback) => {
      calls.push(a);
      queueMicrotask(() => callback(null, "C:\\x\\a.ts:1:hit\nC:\\x\\b.ts:9:hit", ""));
      return { stdin: { end() {} } };
    };
    const res = await runRg({ pattern: "hit", output_mode: "content", context: 0 }, 250, undefined, exec);
    expect(calls).toHaveLength(1);
    expect(res.metadata?.match_count).toBe(2);
  });

  it("omits match_count instead of guessing when the count pass fails", async () => {
    const exec: ExecFileLike = (_file, a, _options, callback) => {
      const isCount = a.includes("-c");
      const error = isCount ? Object.assign(new Error("boom"), { code: "EACCES" }) : null;
      queueMicrotask(() => callback(error, isCount ? "" : "C:\\x\\a.ts:1:hit", ""));
      return { stdin: { end() {} } };
    };
    const res = await runRg({ pattern: "hit", output_mode: "content" }, 250, undefined, exec);
    expect(res.isError).toBeFalsy();
    expect(res.metadata).not.toHaveProperty("match_count");
    expect(res.metadata).toMatchObject({ pattern: "hit", mode: "content" });
  });
});

// Skeptic repro (defect 2): fallback divergences from rg.
describe("grep fallbackSearch — rg divergences fixed (EOF phantom, binary files)", () => {
  it("emits no phantom EOF context line when a match sits within context-distance of a trailing newline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grepeof-"));
    const file = join(dir, "tail.txt");
    writeFileSync(file, "alpha\nbeta\nneedle end\n"); // match on the LAST line
    const res = await fallbackSearch({ pattern: "needle", path: dir, output_mode: "content" }, 250);
    // Pre-fix: the trailing "\n" left a "" element rendered as `...tail.txt-4-`.
    expect(res.content.split("\n")).toEqual([
      `${file}-1-alpha`,
      `${file}-2-beta`,
      `${file}:3:needle end`,
    ]);
  });

  it("skips binary (NUL-containing) files exactly as rg's traversal does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grepbin-"));
    const text = join(dir, "hit.txt");
    writeFileSync(text, "needle in text\n");
    writeFileSync(join(dir, "blob.bin"), new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01, 0xff]));
    const res = await fallbackSearch({ pattern: "needle", path: dir, output_mode: "content" }, 250);
    expect(res.content).not.toContain("blob.bin");
    expect(res.content).not.toContain("\0");
    expect(res.content).toContain(`${text}:1:needle in text`);
    expect(res.metadata?.match_count).toBe(1);
  });
});

// Skeptic repro (round 3): when head_limit bit, the fallback stopped WALKING —
// so its counts covered only the rendered files (reported 2, truth 6) while
// the rg path's -c pass ignores head_limit (reported 6). The fallback now
// finishes the walk in count-only mode once the render budget is exhausted,
// so both paths agree on the exact totals whenever output is truncated —
// which is the COMMON case now that default context multiplies output ~9x.
describe("grep — counts stay exact when head_limit truncates (path parity)", () => {
  /** 6 files, exactly 1 match each, 3 lines per file. */
  function makeSixFileTree(): string {
    const dir = mkdtempSync(join(tmpdir(), "grepsix-"));
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      writeFileSync(join(dir, `${name}.txt`), `pre ${name}\nneedle ${name}\npost ${name}\n`);
    }
    return dir;
  }

  it("content mode, truncating head_limit → match_count 6 and truncated:true on BOTH paths", async () => {
    const dir = makeSixFileTree();
    const args = { pattern: "needle", path: dir, output_mode: "content", head_limit: 5 };
    const rg = await runRg(args, 5);
    const fb = await fallbackSearch(args, 5);
    expect(rg.isError).toBeFalsy();
    expect(rg.metadata?.match_count).toBe(6);
    expect(fb.metadata?.match_count).toBe(6);
    expect(rg.metadata?.truncated).toBe(true);
    expect(fb.metadata?.truncated).toBe(true);
  });

  it("same defect class in files_with_matches mode: file_count 6 on both paths despite a limit of 3", async () => {
    const dir = makeSixFileTree();
    const args = { pattern: "needle", path: dir };
    const rg = await runRg(args, 3);
    const fb = await fallbackSearch(args, 3);
    expect(rg.isError).toBeFalsy();
    expect(rg.metadata?.file_count).toBe(6);
    expect(fb.metadata?.file_count).toBe(6);
    expect(rg.metadata?.truncated).toBe(true);
    expect(fb.metadata?.truncated).toBe(true);
  });

  it("fallback flags truncated even when the render budget lands exactly on a file boundary", async () => {
    const dir = makeSixFileTree();
    // files mode, limit 6 renders every line — nothing hidden → NOT truncated.
    const exact = await fallbackSearch({ pattern: "needle", path: dir }, 6);
    expect(exact.metadata?.truncated).toBeUndefined();
    expect(exact.metadata?.file_count).toBe(6);
    // limit 2: two lines rendered, third file's hit suppressed at the loop-top
    // check (lines.length == limit, no overshoot) — renderCut must still flag it.
    const cut = await fallbackSearch({ pattern: "needle", path: dir }, 2);
    expect(cut.metadata?.truncated).toBe(true);
    expect(cut.metadata?.file_count).toBe(6);
  });
});

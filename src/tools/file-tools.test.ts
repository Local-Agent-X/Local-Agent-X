// file-tools served-file-note regression. Proves that a write/edit under the
// cwd of a LIVE process_start session appends the "may be serving this file"
// note — right-time guidance so an edit doesn't silently appear to "not take
// effect" against a stale server. Spawns a real short-lived node process (no
// bash/sleep/port-binding) and reaps it in afterEach.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTool, editTool, editLinesTool, multiEditTool } from "./file-tools.js";
import { processStartTool, processKillTool, processStatusTool } from "./process-tools.js";

const FOREVER = `"${process.execPath}" -e "setInterval(()=>{},1000)"`;
const spawned = new Set<string>();
const dirs = new Set<string>();

async function pollRunning(sessionId: string, want: boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await processStatusTool.execute({ session_id: sessionId });
    if ((r.metadata?.running === true) === want) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

afterEach(async () => {
  for (const id of spawned) {
    try { await processKillTool.execute({ session_id: id }); } catch { /* best effort */ }
  }
  spawned.clear();
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  dirs.clear();
});

describe("file-tools served-file note", () => {
  it("write under a live session's cwd appends a serving note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-served-"));
    dirs.add(dir);
    const r = await processStartTool.execute({ command: FOREVER, cwd: dir });
    const id = r.session_id ?? "";
    spawned.add(id);
    expect(await pollRunning(id, true)).toBe(true);

    const res = await writeTool.execute({ path: join(dir, "served.js"), content: "module.exports = 1;\n" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/may be serving this file/);
    expect(res.content).toContain(id);
    expect(res.content).toMatch(/process_restart/);
  }, 20_000);

  it("edit with no matching live session has no serving note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-unserved-"));
    dirs.add(dir);
    const file = join(dir, "plain.txt");
    writeFileSync(file, "alpha\nbeta\n", "utf-8");

    const res = await editTool.execute({ path: file, old_string: "alpha", new_string: "gamma" });
    expect(res.isError).toBeFalsy();
    expect(res.content).not.toMatch(/may be serving this file/);
  });
});

// Whitespace-tolerant edit fallback. Reproduces the failure mode that opened
// the circuit breaker on the squishy-game session (2026-06-09): the model's
// old_string had the right content but the wrong leading indentation, so the
// exact-match matcher rejected it. The fallback rebases onto the file's real
// indentation and preserves relative structure.
describe("file-tools whitespace-tolerant edit", () => {
  it("lands an edit when old_string indentation is wrong but content matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-ws-"));
    dirs.add(dir);
    const file = join(dir, "index.html");
    writeFileSync(file, "<div id=\"shop-tab\">\n    <h2>Shop</h2>\n    <div class=\"grid\" id=\"shop-grid\"></div>\n</div>\n", "utf-8");

    // Model under-indents (2 spaces vs the file's 4) and adds a nested line.
    const res = await editTool.execute({
      path: file,
      old_string: "  <h2>Shop</h2>\n  <div class=\"grid\" id=\"shop-grid\"></div>",
      new_string: "  <h2>Shop</h2>\n    <span>Sam</span>\n  <div class=\"grid\" id=\"shop-grid\"></div>",
    });
    expect(res.isError).toBeFalsy();

    const after = readFileSync(file, "utf-8");
    // Rebased to the file's 4-space frame (not the model's 2)...
    expect(after).toMatch(/\n {4}<h2>Shop<\/h2>/);
    expect(after).not.toMatch(/\n {2}<h2>Shop<\/h2>\n/);
    // ...with the model's +2 relative indent preserved (4 + 2 = 6 spaces).
    expect(after).toMatch(/\n {6}<span>Sam<\/span>/);
  });

  it("refuses to guess when the block is ambiguous ignoring whitespace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-ws-amb-"));
    dirs.add(dir);
    const file = join(dir, "dup.txt");
    writeFileSync(file, "block:\n  value\nblock:\n    value\n", "utf-8");

    const res = await editTool.execute({ path: file, old_string: "block:\nvalue", new_string: "block:\nCHANGED" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/multiple places ignoring whitespace/);
  });
});

describe("edit_lines (line-number edits)", () => {
  it("replaces an inclusive line range", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-lines-"));
    dirs.add(dir);
    const file = join(dir, "f.txt");
    writeFileSync(file, "a\nb\nc\nd\n", "utf-8");

    const res = await editLinesTool.execute({ path: file, start_line: 2, end_line: 3, new_string: "X\nY" });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("a\nX\nY\nd\n");
  });

  it("inserts after an anchor line without replacing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-lines-ins-"));
    dirs.add(dir);
    const file = join(dir, "f.txt");
    writeFileSync(file, "a\nb\nc\n", "utf-8");

    const res = await editLinesTool.execute({ path: file, start_line: 2, new_string: "NEW", insert: "after" });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("a\nb\nNEW\nc\n");
  });

  it("rejects an out-of-range line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-lines-oob-"));
    dirs.add(dir);
    const file = join(dir, "f.txt");
    writeFileSync(file, "a\nb\n", "utf-8");

    const res = await editLinesTool.execute({ path: file, start_line: 99, new_string: "X" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/out of range/);
  });
});

describe("multi_edit (atomic batched edits)", () => {
  it("applies all edits in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-multi-"));
    dirs.add(dir);
    const file = join(dir, "f.txt");
    writeFileSync(file, "foo bar baz\n", "utf-8");

    const res = await multiEditTool.execute({
      path: file,
      edits: [{ old_string: "foo", new_string: "FOO" }, { old_string: "baz", new_string: "BAZ" }],
    });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(file, "utf-8")).toBe("FOO bar BAZ\n");
  });

  it("writes nothing if any edit fails to match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-multi-fail-"));
    dirs.add(dir);
    const file = join(dir, "f.txt");
    writeFileSync(file, "foo bar\n", "utf-8");

    const res = await multiEditTool.execute({
      path: file,
      edits: [{ old_string: "foo", new_string: "FOO" }, { old_string: "NOPE", new_string: "X" }],
    });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/aborted at edit 2\/2/);
    expect(readFileSync(file, "utf-8")).toBe("foo bar\n"); // untouched
  });
});

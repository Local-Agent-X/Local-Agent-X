// file-tools served-file-note regression. Proves that a write/edit under the
// cwd of a LIVE process_start session appends the "may be serving this file"
// note — right-time guidance so an edit doesn't silently appear to "not take
// effect" against a stale server. Spawns a real short-lived node process (no
// bash/sleep/port-binding) and reaps it in afterEach.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTool, editTool } from "./file-tools.js";
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

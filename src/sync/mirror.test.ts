// SV-10: the workspace mirror used to walk the entire tree with
// readdirSync/readFileSync/writeFileSync on the event-loop thread inside every
// push(). A heartbeat firing mid-turn then stalled all HTTP/streaming for the
// copy's whole duration. mirrorDir is now async (fs/promises) so it yields the
// loop between file operations. These invariants would fail on the old
// synchronous implementation (which returned void and never yielded).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mirrorDir } from "./mirror.js";

describe("mirrorDir (async, non-blocking workspace copy)", () => {
  let root: string;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it("yields the event loop during the copy instead of blocking it, and still mirrors files", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-mirror-"));
    const src = join(root, "src");
    const dest = join(root, "dest");
    mkdirSync(src, { recursive: true });
    for (let i = 0; i < 25; i++) writeFileSync(join(src, `f${i}.md`), `content ${i}`);

    // Start the copy, then race its completion against a task queued on the
    // event loop's check phase. On the old synchronous mirror the walk ran to
    // completion before control ever returned, so the setImmediate task could
    // not fire first (and mirrorDir returned void, so `.then` would throw). The
    // async walk suspends on its first await, so the loop is serviced mid-copy.
    const pending = mirrorDir(src, dest, /* additiveOnly */ true);
    const winner = await Promise.race([
      pending.then(() => "copy-finished"),
      new Promise<string>((resolve) => setImmediate(() => resolve("event-loop-serviced"))),
    ]);
    expect(winner).toBe("event-loop-serviced");

    // And correctness is preserved: every syncable file is copied verbatim.
    await pending;
    for (let i = 0; i < 25; i++) {
      expect(readFileSync(join(dest, `f${i}.md`), "utf-8")).toBe(`content ${i}`);
    }
  });

  it("excludes downloads/ from the mirror (browser downloads are machine-local)", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-mirror-"));
    const src = join(root, "src");
    const dest = join(root, "dest");
    // downloads/ holds arbitrary web files saved by the browser handler
    // (src/browser/downloads.ts) — syncing them would propagate downloads
    // across machines through the workspace sync repo.
    mkdirSync(join(src, "downloads"), { recursive: true });
    writeFileSync(join(src, "downloads", "grabbed.pdf"), "web bytes");
    mkdirSync(join(src, "docs"), { recursive: true });
    writeFileSync(join(src, "docs", "notes.md"), "keep me");

    await mirrorDir(src, dest, /* additiveOnly */ true);

    expect(existsSync(join(dest, "downloads"))).toBe(false);
    expect(readFileSync(join(dest, "docs", "notes.md"), "utf-8")).toBe("keep me");
  });
});

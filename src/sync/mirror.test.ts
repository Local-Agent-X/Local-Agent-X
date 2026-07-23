// SV-10: the workspace mirror used to walk the entire tree with
// readdirSync/readFileSync/writeFileSync on the event-loop thread inside every
// push(). A heartbeat firing mid-turn then stalled all HTTP/streaming for the
// copy's whole duration. mirrorDir is now async (fs/promises) so it yields the
// loop between file operations. These invariants would fail on the old
// synchronous implementation (which returned void and never yielded).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mirrorDir, pullDir } from "./mirror.js";

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

  // 2026-07-22 live failure: container worktrees under workspace/.worktrees
  // carried a .pnpm-store with a materialized workspace→workspace recursion;
  // ~4 GB of it mirrored into sync-repo and every git command there died on
  // Windows path-length limits, wedging sync. These invariants pin the fix.
  it("never copies tooling-state dirs (.worktrees, .pnpm-store) into the mirror", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-mirror-"));
    const src = join(root, "src");
    const dest = join(root, "dest");
    mkdirSync(join(src, ".worktrees", "c4"), { recursive: true });
    writeFileSync(join(src, ".worktrees", "c4", "junk.md"), "junk");
    mkdirSync(join(src, ".pnpm-store", "v11"), { recursive: true });
    writeFileSync(join(src, ".pnpm-store", "v11", "index.json"), "{}");
    writeFileSync(join(src, "real.md"), "real");

    await mirrorDir(src, dest, /* additiveOnly */ true);
    expect(readFileSync(join(dest, "real.md"), "utf-8")).toBe("real");
    expect(existsSync(join(dest, ".worktrees"))).toBe(false);
    expect(existsSync(join(dest, ".pnpm-store"))).toBe(false);
  });

  it("never follows symlinks — a directory loop must not materialize in dest", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-mirror-"));
    const src = join(root, "src");
    const dest = join(root, "dest");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "keep.md"), "keep");
    try {
      // A link pointing back at src's own parent: following it recurses forever.
      symlinkSync(root, join(src, "loop"), "junction");
    } catch {
      return; // symlink creation needs privileges this runner lacks — nothing to pin
    }

    await mirrorDir(src, dest, /* additiveOnly */ true);
    expect(readFileSync(join(dest, "keep.md"), "utf-8")).toBe("keep");
    expect(existsSync(join(dest, "loop"))).toBe(false);
  });

  it("skips entries whose destination path exceeds the git-safe length limit", async () => {
    root = mkdtempSync(join(tmpdir(), "lax-mirror-"));
    const src = join(root, "src");
    const dest = join(root, "dest");
    // Deep chain of 30-char segments: shallow levels fit under the 240-char
    // dest cap, deep ones cross it and must be pruned.
    const seg = "a".repeat(30);
    let deep = src;
    for (let i = 0; i < 12; i++) { deep = join(deep, seg); }
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "too-deep.md"), "unreachable by git");
    writeFileSync(join(src, "shallow.md"), "fine");

    await mirrorDir(src, dest, /* additiveOnly */ true);
    expect(readFileSync(join(dest, "shallow.md"), "utf-8")).toBe("fine");
    // Walk the copied chain: it must stop before the 240-char boundary.
    let copied = join(dest, seg);
    let depth = 0;
    while (existsSync(copied)) { depth++; copied = join(copied, seg); }
    expect(depth).toBeLessThan(12);
    expect((join(dest, ...Array(depth + 1).fill(seg))).length).toBeGreaterThan(240);
  });

  it("pullDir applies the same skip rules and never deletes local dirs it skipped", () => {
    root = mkdtempSync(join(tmpdir(), "lax-mirror-"));
    const src = join(root, "sync-repo-ws");
    const dest = join(root, "workspace");
    // A poisoned sync-repo (written by a machine running pre-guard code).
    mkdirSync(join(src, ".worktrees", "c4"), { recursive: true });
    writeFileSync(join(src, ".worktrees", "c4", "junk.md"), "junk");
    writeFileSync(join(src, "real.md"), "real");
    // Local workspace already has its own .worktrees — must survive even in
    // legacy destructive mode, since "skipped" must never read as "deleted".
    mkdirSync(join(dest, ".worktrees", "local"), { recursive: true });
    writeFileSync(join(dest, ".worktrees", "local", "mine.md"), "mine");

    pullDir(src, dest, /* additiveOnly */ false);
    expect(readFileSync(join(dest, "real.md"), "utf-8")).toBe("real");
    expect(existsSync(join(dest, ".worktrees", "c4"))).toBe(false);
    expect(readFileSync(join(dest, ".worktrees", "local", "mine.md"), "utf-8")).toBe("mine");
  });
});

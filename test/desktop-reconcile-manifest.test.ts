// Regression for the per-launch source content-hash: reconcile used to
// sha256 ~1800 .ts files (full reads) on EVERY launch — the biggest
// deterministic Windows launch cost, since Defender scans every read.
// srcTreeHashCached now reuses the stored hash when a stat-only
// (size+mtime) manifest matches the tree exactly. The dangerous direction
// is a false-"unchanged": returning the stored hash for a tree that DID
// change would skip a rebuild — so every mismatch class is pinned here to
// fall back to the real content hash, against real files with explicit
// mtimes (no mocks; the bug would live in the walk/compare).
//
// Fast-path proof: the stored hash passed in is a SENTINEL that can never
// equal a real sha256 of the tree. Getting the sentinel back proves no
// content was re-hashed; getting a real hash back proves the fallback ran.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { srcTreeHashCached, sha256SrcTree, buildSrcManifest } from "../desktop/src/reconcile-hash";

const T0 = new Date("2026-01-01T00:00:00Z");
const SENTINEL = "sentinel-not-a-real-sha256";

let root: string;
let src: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-reconcile-manifest-"));
  src = join(root, "desktop", "src");
  writeAt(join(src, "main.ts"), "console.log('main');\n", T0);
  writeAt(join(src, "ipc", "handlers.ts"), "export const h = 1;\n", T0);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAt(path: string, content: string, time: Date): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, time, time);
}

async function baseline(): Promise<{ hash: string; manifest: ReturnType<typeof buildSrcManifest> }> {
  return await srcTreeHashCached(src, root, undefined, undefined);
}

describe("srcTreeHashCached fast path", () => {
  it("returns the stored hash untouched when the tree is unchanged — no content re-hash", async () => {
    const { manifest } = await baseline();
    const res = await srcTreeHashCached(src, root, manifest, SENTINEL);
    expect(res.hash).toBe(SENTINEL);
    expect(res.manifest).toEqual(manifest);
  });

  it("with no stored manifest, computes the real content hash", async () => {
    const res = await srcTreeHashCached(src, root, undefined, undefined);
    expect(res.hash).toBe(await sha256SrcTree(src, root));
  });
});

describe("srcTreeHashCached falls back to the content hash on any mismatch", () => {
  async function expectFallback(manifest: ReturnType<typeof buildSrcManifest>): Promise<void> {
    const res = await srcTreeHashCached(src, root, manifest, SENTINEL);
    expect(res.hash).not.toBe(SENTINEL);
    // ...and the fallback is the definitive content hash, not some third thing.
    expect(res.hash).toBe(await sha256SrcTree(src, root));
    expect(res.manifest).toEqual(buildSrcManifest(src, root));
  }

  it("size change (mtime pinned back to original)", async () => {
    const { manifest } = await baseline();
    writeAt(join(src, "main.ts"), "console.log('main'); // grew\n", T0);
    expect(statSync(join(src, "main.ts")).mtimeMs).toBe(manifest.find(e => e.path.endsWith("main.ts"))!.mtimeMs);
    await expectFallback(manifest);
  });

  it("mtime moved FORWARD (same size)", async () => {
    const { manifest } = await baseline();
    const later = new Date("2026-01-01T01:00:00Z");
    utimesSync(join(src, "main.ts"), later, later);
    await expectFallback(manifest);
  });

  it("mtime moved BACKWARD (same size) — a rollback is still a change", async () => {
    const { manifest } = await baseline();
    const earlier = new Date("2025-12-31T00:00:00Z");
    utimesSync(join(src, "main.ts"), earlier, earlier);
    await expectFallback(manifest);
  });

  it("file added", async () => {
    const { manifest } = await baseline();
    writeAt(join(src, "new-module.ts"), "export {};\n", T0);
    await expectFallback(manifest);
  });

  it("file removed", async () => {
    const { manifest } = await baseline();
    rmSync(join(src, "ipc", "handlers.ts"));
    await expectFallback(manifest);
  });
});

describe("manifest walk shares the content hash's file-set rules", () => {
  it("node_modules and dist churn does not break the fast path (both walks skip them)", async () => {
    const { manifest } = await baseline();
    writeAt(join(src, "node_modules", "dep", "index.ts"), "export {};\n", T0);
    writeAt(join(src, "dist", "main.ts"), "compiled\n", T0);
    const res = await srcTreeHashCached(src, root, manifest, SENTINEL);
    expect(res.hash).toBe(SENTINEL);
  });

  it("non-.ts files are invisible to both walks", async () => {
    const { manifest } = await baseline();
    writeAt(join(src, "notes.md"), "scratch\n", new Date("2026-02-01T00:00:00Z"));
    const res = await srcTreeHashCached(src, root, manifest, SENTINEL);
    expect(res.hash).toBe(SENTINEL);
  });
});

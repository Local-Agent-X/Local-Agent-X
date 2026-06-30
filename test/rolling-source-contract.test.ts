import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRollingSource } from "../scripts/build-rolling-source.mjs";
// The REAL verifier the in-app updater runs. Importing it (not a copy) is the
// whole point: this test proves the PUBLISH side (build-rolling-source) emits
// exactly what the VERIFY side (ota-update) accepts — the cross-seam contract
// that was the open gap. If either side drifts, this fails.
import { assertSha256 } from "../src/ota-update.js";

// `git archive` needs a real commit; HEAD always exists in the repo under test.
const sha = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();

let outDir: string;
let built: ReturnType<typeof buildRollingSource>;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "rolling-source-"));
  built = buildRollingSource(sha, outDir);
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("rolling-source publish ⟷ verify contract", () => {
  it("names the asset exactly as the app resolves it (lax-source-<full-sha>.tar.gz)", () => {
    // The app builds this name from the GitHub commits API `sha` (full 40 chars)
    // — any divergence and the verified path silently never matches.
    expect(built.assetName).toBe(`lax-source-${sha}.tar.gz`);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("the published sidecar passes the real assertSha256 over the published bytes", () => {
    const buf = readFileSync(built.assetPath);
    const sidecar = readFileSync(built.sidecarPath, "utf-8");
    // Must not throw — this is the exact call ota-update.downloadMainTarball makes.
    expect(() => assertSha256(buf, sidecar)).not.toThrow();
  });

  it("writes the sidecar in sha256sum format (hash + two spaces + filename)", () => {
    const sidecar = readFileSync(built.sidecarPath, "utf-8");
    expect(sidecar).toBe(`${built.hash}  ${built.assetName}\n`);
    expect(built.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("assertSha256 REJECTS a tampered asset (the guard actually bites)", () => {
    const buf = readFileSync(built.assetPath);
    const tampered = Buffer.from(buf);
    tampered[tampered.length - 1] ^= 0xff; // flip the last byte
    const sidecar = readFileSync(built.sidecarPath, "utf-8");
    expect(() => assertSha256(tampered, sidecar)).toThrow(/checksum mismatch/);
  });

  it("extracts cleanly with --strip-components=1 to the source root (applyUpdate's contract)", () => {
    const extractDir = join(outDir, "extract");
    mkdirSync(extractDir, { recursive: true });
    // Mirror applyUpdate: run from the tarball's dir with a relative name.
    execFileSync("tar", ["xzf", built.assetName, "-C", extractDir, "--strip-components=1"], { cwd: outDir });
    // package.json must land at the extract root (proves the single-prefix shape).
    const pkg = JSON.parse(readFileSync(join(extractDir, "package.json"), "utf-8"));
    expect(pkg.name).toBeTruthy();
    // node_modules must NOT ride along (git archive ships tracked source only).
    expect(() => readFileSync(join(extractDir, "node_modules", ".bin", "tsc"))).toThrow();
  });

  it("refuses a short / malformed sha (won't publish an asset the app can't address)", () => {
    expect(() => buildRollingSource(sha.slice(0, 12), outDir)).toThrow(/40-char commit sha/);
  });
});

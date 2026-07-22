// Regression locks for the 3-day silent-stale desktop failure class:
//
//   1. depsInstalled trusted node_modules/.package-lock.json alone, so a gutted
//      tree (observed: an EMPTY node_modules/electron) passed and the heal
//      npm-install never ran — pinned here with the "electron" marker package.
//   2. A stale desktop/dist with no rebuild scheduled had NO signal at all
//      (rebuild only triggers on srcChanged) — staleDistDecision is the pure
//      decision reconcile now surfaces through OS notification / splash hint /
//      renderer banner.
//   3. The update pipeline's desktop pre-build failure was warn-only — it now
//      writes a cross-boot marker (server-side ESM writer, desktop-side CJS
//      reader; they cannot import each other, so this test pins the shared
//      path convention AND the payload round trip).
//   4. A pnpm run in this npm-managed repo rewrote node_modules mid-run (vitest
//      vanished while tests were executing) and gutted desktop electron —
//      foreignPmCorruption detects the rewrite so reconcile can wipe + heal.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  depsInstalled,
  foreignPmCorruption,
  staleDistDecision,
  readDesktopPrebuildMarker,
  clearDesktopPrebuildMarker,
  DESKTOP_PREBUILD_MARKER_PATH as MARKER_PATH_DESKTOP_SIDE,
} from "../desktop/src/reconcile-hash";
import {
  recordDesktopPrebuildOutcome,
  DESKTOP_PREBUILD_MARKER_PATH as MARKER_PATH_SERVER_SIDE,
} from "../src/desktop-prebuild-marker.js";
import { desktopDistMtimeFresh } from "../desktop/src/dist-freshness";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-reconcile-deps-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("depsInstalled — manifest alone is not proof", () => {
  const manifest = () => join(root, "node_modules", ".package-lock.json");

  it("false when node_modules is missing entirely", () => {
    expect(depsInstalled(root)).toBe(false);
    expect(depsInstalled(root, "electron")).toBe(false);
  });

  it("true with the npm install manifest and no marker package requested (root behavior unchanged)", () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(manifest(), "{}");
    expect(depsInstalled(root)).toBe(true);
  });

  it("FALSE when the marker package dir is empty despite the manifest — the gutted-electron case", () => {
    mkdirSync(join(root, "node_modules", "electron"), { recursive: true }); // empty dir, no package.json
    writeFileSync(manifest(), "{}");
    expect(depsInstalled(root, "electron")).toBe(false);
  });

  it("true when the marker package is actually populated", () => {
    mkdirSync(join(root, "node_modules", "electron"), { recursive: true });
    writeFileSync(manifest(), "{}");
    writeFileSync(join(root, "node_modules", "electron", "package.json"), '{"name":"electron"}');
    expect(depsInstalled(root, "electron")).toBe(true);
  });
});

describe("foreignPmCorruption — a pnpm rewrite of an npm tree is corruption, not health", () => {
  const nm = () => join(root, "node_modules");
  const cleanNpmLayout = () => {
    mkdirSync(join(nm(), "electron"), { recursive: true });
    writeFileSync(join(nm(), ".package-lock.json"), "{}");
    writeFileSync(join(nm(), "electron", "package.json"), '{"name":"electron"}');
  };

  it("null when node_modules is missing entirely — deps MISSING, not corrupt", () => {
    expect(foreignPmCorruption(root)).toBeNull();
    expect(depsInstalled(root)).toBe(false); // still unhealthy, via the plain missing-deps path
  });

  it("clean npm layout is healthy — no corruption, depsInstalled true", () => {
    cleanNpmLayout();
    expect(foreignPmCorruption(root)).toBeNull();
    expect(depsInstalled(root)).toBe(true);
    expect(depsInstalled(root, "electron")).toBe(true);
  });

  it("CORRUPT when node_modules/.pnpm exists — even with npm's manifest and marker package intact", () => {
    cleanNpmLayout();
    mkdirSync(join(nm(), ".pnpm"), { recursive: true });
    const cause = foreignPmCorruption(root);
    expect(cause).toMatch(/another package manager \(pnpm\)/);
    expect(cause).toContain(".pnpm");
    expect(depsInstalled(root)).toBe(false);
    expect(depsInstalled(root, "electron")).toBe(false);
  });

  it("CORRUPT when node_modules/.modules.yaml exists — pnpm's tree manifest", () => {
    cleanNpmLayout();
    writeFileSync(join(nm(), ".modules.yaml"), "layoutVersion: 5");
    const cause = foreignPmCorruption(root);
    expect(cause).toMatch(/another package manager \(pnpm\)/);
    expect(cause).toContain(".modules.yaml");
    expect(depsInstalled(root)).toBe(false);
  });

  it("CORRUPT when node_modules exists without npm's .package-lock.json manifest", () => {
    mkdirSync(join(nm(), "some-pkg"), { recursive: true });
    const cause = foreignPmCorruption(root);
    expect(cause).toMatch(/\.package-lock\.json/);
    expect(depsInstalled(root)).toBe(false);
  });
});

describe("staleDistDecision — stale dist must be loud unless a rebuild will fix it", () => {
  const quietOpts = { depsWereMissing: false, prebuildFailDetail: null };

  it("quiet when dist is fresh", () => {
    expect(staleDistDecision({ distFresh: true, rebuildPlanned: false, ...quietOpts })).toBeNull();
  });

  it("quiet when a rebuild is planned this boot — the rebuild handles it", () => {
    expect(staleDistDecision({ distFresh: false, rebuildPlanned: true, ...quietOpts })).toBeNull();
  });

  it("NOTIFIES when dist is stale and no rebuild is planned — the silent 3-day case", () => {
    const reason = staleDistDecision({ distFresh: false, rebuildPlanned: false, ...quietOpts });
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/older than its source/);
  });

  it("names the failed update pre-build (first line only) when the marker is present", () => {
    const reason = staleDistDecision({
      distFresh: false, rebuildPlanned: false, depsWereMissing: false,
      prebuildFailDetail: "tsc exited 2: error TS2304\nsecond line never shown",
    });
    expect(reason).toContain("tsc exited 2: error TS2304");
    expect(reason).not.toContain("second line");
  });

  it("names incomplete desktop dependencies when that was the detected cause", () => {
    const reason = staleDistDecision({
      distFresh: false, rebuildPlanned: false, depsWereMissing: true, prebuildFailDetail: null,
    });
    expect(reason).toMatch(/dependencies were incomplete/);
  });
});

describe("desktopDistMtimeFresh — the warning signal must ignore the git stamp", () => {
  // A server-only pull moves HEAD without touching desktop/src; nothing ever
  // re-stamps desktop/dist/.builtref, so a stamp-aware warning would nag on
  // every boot over a dist whose content is current — unfixable noise.
  it("stays fresh when only the .builtref stamp is stale", async () => {
    const OLD = new Date("2026-01-01T00:00:00Z");
    const NEW = new Date("2026-01-01T01:00:00Z");
    const write = (p: string, t: Date) => {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "x");
      utimesSync(p, t, t);
    };
    write(join(root, "desktop", "src", "main.ts"), OLD);
    write(join(root, "desktop", "dist", "main.js"), NEW);
    // fake git checkout on commit B, dist stamped from commit A
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "b".repeat(40) + "\n");
    writeFileSync(join(root, "desktop", "dist", ".builtref"), "a".repeat(40) + "\n");
    await expect(desktopDistMtimeFresh(root)).resolves.toBe(true);
    // and it still reports genuine mtime staleness
    write(join(root, "desktop", "src", "main.ts"), new Date("2026-01-01T02:00:00Z"));
    await expect(desktopDistMtimeFresh(root)).resolves.toBe(false);
  });
});

describe("desktop pre-build marker — server writer ↔ desktop reader round trip", () => {
  const marker = () => join(root, "desktop-prebuild-pending.json");

  it("both sides agree on the default marker path (the cross-side convention)", () => {
    expect(MARKER_PATH_SERVER_SIDE).toBe(MARKER_PATH_DESKTOP_SIDE);
  });

  it("a failed pre-build writes a marker the desktop reader round-trips", () => {
    recordDesktopPrebuildOutcome(false, "tsc exited 2: error TS2304: Cannot find name 'x'.", marker());
    const read = readDesktopPrebuildMarker(marker());
    expect(read).not.toBeNull();
    expect(read!.detail).toContain("error TS2304");
    expect(typeof read!.failedAt).toBe("string");
  });

  it("a successful pre-build clears a leftover failure marker", () => {
    recordDesktopPrebuildOutcome(false, "boom", marker());
    expect(existsSync(marker())).toBe(true);
    recordDesktopPrebuildOutcome(true, "", marker());
    expect(existsSync(marker())).toBe(false);
    expect(readDesktopPrebuildMarker(marker())).toBeNull();
  });

  it("clearDesktopPrebuildMarker removes the marker and tolerates absence", () => {
    recordDesktopPrebuildOutcome(false, "boom", marker());
    clearDesktopPrebuildMarker(marker());
    expect(existsSync(marker())).toBe(false);
    clearDesktopPrebuildMarker(marker()); // absent — must not throw
  });

  it("a corrupt marker reads as absent — never blocks boot", () => {
    writeFileSync(marker(), "{not json");
    expect(readDesktopPrebuildMarker(marker())).toBeNull();
    writeFileSync(marker(), JSON.stringify({ failedAt: "x" })); // missing detail
    expect(readDesktopPrebuildMarker(marker())).toBeNull();
  });
});

/**
 * frameworkScaffoldPresent — the spawn-layer bypass that keeps
 * build-app-spawn.ts's flat-HTML artifact veto (artifactLooksComplete on a
 * root index.html) from failing framework builds: a Next/Vite scaffold has
 * no root index.html, so before the bypass a successful framework build was
 * reported as "no index.html written" (isError). The adapter terminal
 * (app-build-finalize.ts) does the real framework verification — this gate
 * only decides whether the spawn layer may veto first.
 *
 * Unit-level like build-app-spawn-cancel.test.ts: runCliBuild assumes the
 * codex/claude binaries exist, so the gate function is exercised directly —
 * no CLI subprocess is spawned.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameworkScaffoldPresent } from "../src/tools/build-app-spawn.js";

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-fw-gate-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe("frameworkScaffoldPresent — spawn-layer artifact-veto bypass", () => {
  it("Next-shaped dir (next.config.js + package.json, no index.html) passes the veto", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "next.config.js"), "export default {};\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "stitch", dependencies: { next: "^15.0.0" },
    }));
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    writeFileSync(join(dir, "src", "app", "page.tsx"), "export default function Page() { return null; }\n");
    expect(frameworkScaffoldPresent(dir)).toBe(true);
  });

  it("Vite SPA (vite.config.ts + package.json with vite devDependency) passes the veto", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "vite.config.ts"), "export default {};\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "spa", devDependencies: { vite: "^6.0.0" },
    }));
    expect(frameworkScaffoldPresent(dir)).toBe(true);
  });

  it("empty dir still vetoes (no scaffold, no bypass)", () => {
    expect(frameworkScaffoldPresent(makeDir())).toBe(false);
  });

  it("flat-HTML dir (index.html, no package.json) does NOT bypass — the flat integrity check owns it", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>fixture</body></html>");
    expect(frameworkScaffoldPresent(dir)).toBe(false);
  });

  it("framework config without package.json does NOT bypass (incomplete scaffold)", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "next.config.js"), "export default {};\n");
    expect(frameworkScaffoldPresent(dir)).toBe(false);
  });
});

/**
 * app_rebuild behavior — the adapter's own decision surface, with the build
 * runner injected so no test spawns a real `npx vite build`. The wiring
 * (barrel / policy / ARI map / capability classes) is pinned separately in
 * test/app-rebuild-registration-funnel.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeAppRebuild, type AppRebuildDeps } from "./app-rebuild-tool.js";
import { writeRunTargetManifest, readRunTargetManifest } from "./app-run-target.js";
import type { DevServerRecord } from "./dev-server.js";
import type { StaticBuildResult } from "./static-build-run.js";

let appsRoot: string;

beforeEach(() => {
  appsRoot = mkdtempSync(join(tmpdir(), "app-rebuild-"));
});
afterEach(() => {
  rmSync(appsRoot, { recursive: true, force: true });
});

function makeViteApp(name: string): string {
  const dir = join(appsRoot, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, dependencies: { vite: "^5.0.0" } }));
  writeFileSync(join(dir, "vite.config.ts"), "export default {};\n");
  writeFileSync(join(dir, "src", "main.tsx"), "// app\n");
  return dir;
}

/** Give the app a built dist/ whose index.html is newer/older than the sources. */
function makeDist(dir: string, opts: { fresh: boolean }): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), "<html></html>");
  writeRunTargetManifest(dir, { mode: "static-build", distDir: "dist", framework: "vite" });
  // Deterministic mtimes — never trust write-order ms resolution.
  const now = Date.now() / 1000;
  const [srcT, distT] = opts.fresh ? [now - 60, now] : [now, now - 60];
  for (const f of ["package.json", "vite.config.ts", join("src", "main.tsx")]) {
    utimesSync(join(dir, f), srcT, srcT);
  }
  utimesSync(join(dir, "dist", "index.html"), distT, distT);
}

function deps(overrides: Partial<AppRebuildDeps> & { buildCalls?: string[] } = {}): AppRebuildDeps & { buildCalls: string[]; stopped: string[] } {
  const buildCalls: string[] = overrides.buildCalls ?? [];
  const stopped: string[] = [];
  return {
    appsRoot,
    runBuild: overrides.runBuild ?? (async (appDir): Promise<StaticBuildResult> => {
      buildCalls.push(appDir);
      mkdirSync(join(appDir, "dist"), { recursive: true });
      writeFileSync(join(appDir, "dist", "index.html"), "<html>built</html>");
      return { ok: true, distDir: "dist" };
    }),
    readRecord: overrides.readRecord ?? (() => null),
    stopServer: overrides.stopServer ?? ((id) => { stopped.push(id); }),
    buildCalls,
    stopped,
  };
}

function frontendRecord(appId: string): DevServerRecord {
  return { appId, command: "npm run dev", cwd: "", port: 5173, connector: `dev-${appId}`, kind: "frontend" };
}

describe("app_rebuild — argument and app-dir validation", () => {
  it("errors when `app` is missing", async () => {
    const r = await executeAppRebuild({}, undefined, deps());
    expect(r.isError).toBe(true);
  });

  it("errors on a missing app dir and lists the apps that DO exist", async () => {
    makeViteApp("real-app");
    const r = await executeAppRebuild({ app: "no-such-app" }, undefined, deps());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no-such-app");
    expect(r.content).toContain("real-app");
  });
});

describe("app_rebuild — framework gating", () => {
  it("refuses a full-stack app (backend dev-server record) and points at app_serve_backend", async () => {
    makeViteApp("full-stack");
    const d = deps({ readRecord: () => ({ ...frontendRecord("full-stack"), kind: "backend" }) });
    const r = await executeAppRebuild({ app: "full-stack" }, undefined, d);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("app_serve_backend");
    expect(d.buildCalls).toEqual([]);
  });

  it("refuses a plain static app — nothing to build, LAX serves it directly", async () => {
    const dir = join(appsRoot, "plain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html></html>");
    const d = deps();
    const r = await executeAppRebuild({ app: "plain" }, undefined, d);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no build step");
    expect(d.buildCalls).toEqual([]);
  });

  it("refuses a non-static-buildable framework with a build_app update recovery hint", async () => {
    const dir = join(appsRoot, "next-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^14.0.0" } }));
    const d = deps();
    const r = await executeAppRebuild({ app: "next-app" }, undefined, d);
    expect(r.isError).toBe(true);
    expect(String(r.metadata?.recovery)).toContain("build_app");
    expect(String(r.metadata?.recovery)).toContain("update: true");
    expect(d.buildCalls).toEqual([]);
  });
});

describe("app_rebuild — freshness gate", () => {
  it("skips the build and reports 'already fresh' when dist is newer than every source", async () => {
    const dir = makeViteApp("fresh-app");
    makeDist(dir, { fresh: true });
    const d = deps();
    const r = await executeAppRebuild({ app: "fresh-app" }, undefined, d);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("already fresh");
    expect(d.buildCalls).toEqual([]);
  });

  it("force: true rebuilds even when dist is fresh", async () => {
    const dir = makeViteApp("forced");
    makeDist(dir, { fresh: true });
    const d = deps();
    const r = await executeAppRebuild({ app: "forced", force: true }, undefined, d);
    expect(r.isError).toBeUndefined();
    expect(d.buildCalls).toEqual([dir]);
  });

  it("rebuilds when the source is newer than dist", async () => {
    const dir = makeViteApp("stale");
    makeDist(dir, { fresh: false });
    const d = deps();
    const r = await executeAppRebuild({ app: "stale" }, undefined, d);
    expect(r.isError).toBeUndefined();
    expect(d.buildCalls).toEqual([dir]);
  });

  it("rebuilds when there is no dist at all", async () => {
    const dir = makeViteApp("no-dist");
    const d = deps();
    await executeAppRebuild({ app: "no-dist" }, undefined, d);
    expect(d.buildCalls).toEqual([dir]);
  });
});

describe("app_rebuild — outcome envelope", () => {
  it("success writes the static-build marker and names the dist dir", async () => {
    const dir = makeViteApp("winner");
    const r = await executeAppRebuild({ app: "winner" }, undefined, deps());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("dist/");
    expect(typeof r.metadata?.duration_ms).toBe("number");
    expect(readRunTargetManifest(dir)).toMatchObject({ mode: "static-build", distDir: "dist", framework: "vite" });
  });

  it("stops a lingering FRONTEND dev server after a successful build, and says so", async () => {
    makeViteApp("hmr-app");
    const d = deps({ readRecord: () => frontendRecord("hmr-app") });
    const r = await executeAppRebuild({ app: "hmr-app" }, undefined, d);
    expect(r.isError).toBeUndefined();
    expect(d.stopped).toEqual(["hmr-app"]);
    expect(r.content).toContain("dev server was stopped");
  });

  it("does NOT stop anything when no dev-server record exists", async () => {
    makeViteApp("solo");
    const d = deps();
    await executeAppRebuild({ app: "solo" }, undefined, d);
    expect(d.stopped).toEqual([]);
  });

  it("a failed build is an error carrying the runner's reason and a recovery hint", async () => {
    const dir = makeViteApp("broken");
    const d = deps({ runBuild: async () => ({ ok: false, error: "static build exited 1: npx vite build\nsome ts error" }) });
    const r = await executeAppRebuild({ app: "broken" }, undefined, d);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("some ts error");
    expect(String(r.metadata?.recovery)).toContain("app_rebuild");
    // A failed build must not write/refresh the marker.
    expect(readRunTargetManifest(dir)).toBeNull();
  });

  it("a runner deadline kill maps to status 'timeout' with the stderr tail as partial_output", async () => {
    makeViteApp("hung");
    const d = deps({ runBuild: async () => ({ ok: false, timedOut: true, error: "static build timed out after 240s: npx vite build\ntranspiling..." }) });
    const r = await executeAppRebuild({ app: "hung" }, undefined, d);
    expect(r.status).toBe("timeout");
    expect(String(r.metadata?.partial_output)).toContain("transpiling");
  });
});

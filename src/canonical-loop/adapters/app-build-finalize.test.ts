/**
 * Unit tests for finalizeFrameworkBuild — the framework-aware completion
 * seam the CLI app-build terminal calls (app-build-adapter.ts).
 *
 * Every dep is injected via FinalizeFrameworkDeps, so nothing here touches
 * real dev-server records, ports, or processes — by design the defaults
 * only resolve (via dynamic import) when a dep is missing. The adapter-level
 * regression for the live Next.js bug lives in
 * test/build-app-adapter-framework.test.ts; this file pins the seam's own
 * contract: routing (handled:false for static/unknown), scaffold gating,
 * failure shaping, and dev-port allocation.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finalizeFrameworkBuild,
  type FinalizeFrameworkDeps,
  type FinalizeFrameworkInput,
} from "./app-build-finalize.js";
import type { DevServerRecord, RegisterResult } from "../../tools/dev-server.js";
import type { StaticBuildResult } from "../../tools/static-build-run.js";
import { readRunTargetManifest } from "../../tools/app-run-target.js";
import type { DetectedFramework } from "../../tools/framework-detect.js";
import { DEFAULT_BASE_PORT } from "../../auto-build/scenario-scorer/port-alloc.js";

const tempDirs: string[] = [];
function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `appbuild-finalize-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** Realistic Next.js scaffold — what the CLI builder actually leaves on disk:
 *  config + package.json with the next dep + an app-router entry, NO index.html. */
function writeNextScaffold(dir: string): void {
  writeFileSync(join(dir, "next.config.js"), `const nextConfig = { basePath: "/apps/stitch" };\nexport default nextConfig;\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "stitch",
    private: true,
    scripts: { dev: "next dev", build: "next build" },
    dependencies: { next: "^15.0.0", react: "^18.3.0", "react-dom": "^18.3.0" },
  }, null, 2));
  mkdirSync(join(dir, "src", "app"), { recursive: true });
  writeFileSync(join(dir, "src", "app", "page.tsx"), "export default function Page() {\n  return <main>stitch</main>;\n}\n");
}

type RegisterCall = { appId: string; command: string; port: number; cwd?: string; kind?: string };
interface DepCalls {
  register: RegisterCall[];
  staticBuild: Array<{ appDir: string; framework: DetectedFramework }>;
  stop: Array<{ appId: string; forget?: boolean }>;
}

function fakeDeps(opts: {
  records?: DevServerRecord[];
  bound?: (port: number) => boolean;
  registerResult?: RegisterResult;
  /** static-build result the injected runStaticBuild returns (default: ok, dist/). */
  staticResult?: StaticBuildResult;
} = {}): { deps: FinalizeFrameworkDeps; calls: DepCalls } {
  const calls: DepCalls = { register: [], staticBuild: [], stop: [] };
  const deps: FinalizeFrameworkDeps = {
    registerDevServer: (input) => {
      calls.register.push(input);
      return opts.registerResult ?? {
        ok: true, connector: `dev-${input.appId}`, sessionId: "sess-1",
        port: input.port, cwd: input.cwd ?? "", restarted: false, kind: input.kind ?? "backend",
      };
    },
    listDevServerRecords: () => opts.records ?? [],
    portBound: opts.bound ?? (() => false),
    runStaticBuild: async (appDir, framework) => {
      calls.staticBuild.push({ appDir, framework });
      return opts.staticResult ?? { ok: true, distDir: "dist" };
    },
    stopDevServer: (appId, o) => { calls.stop.push({ appId, forget: o.forget }); },
  };
  return { deps, calls };
}

function record(appId: string, port: number): DevServerRecord {
  return {
    appId, port,
    command: `npm install && npx next dev --port ${port}`,
    cwd: join(tmpdir(), appId),
    connector: `dev-${appId}`,
    kind: "frontend",
  };
}

function input(appDir: string, over: Partial<FinalizeFrameworkInput> = {}): FinalizeFrameworkInput {
  return { appDir, appName: "stitch", laxPort: "7007", registerServer: true, ...over };
}

describe("finalizeFrameworkBuild — completion-model routing", () => {
  it("static app (index.html, no package.json) → handled:false so the adapter keeps its index.html gate", async () => {
    const dir = makeDir("static");
    writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>fixture</body></html>");
    const { deps, calls } = fakeDeps();
    expect(await finalizeFrameworkBuild(input(dir), deps)).toEqual({ handled: false });
    expect(calls.register).toHaveLength(0);
  });

  it("unknown (empty) dir → handled:false", async () => {
    const { deps, calls } = fakeDeps();
    expect(await finalizeFrameworkBuild(input(makeDir("empty")), deps)).toEqual({ handled: false });
    expect(calls.register).toHaveLength(0);
  });
});

describe("finalizeFrameworkBuild — framework completion", () => {
  it("Next scaffold → ok with the /apps/<name>/ proxy URL and a frontend dev server registered in the app dir", async () => {
    const dir = makeDir("next");
    writeNextScaffold(dir);
    const { deps, calls } = fakeDeps();
    const r = await finalizeFrameworkBuild(input(dir), deps);
    expect(r).toMatchObject({ handled: true, ok: true, framework: "nextjs" });
    if (!r.handled || !r.ok) return;
    // Proxy URL: trailing slash, NO index.html — the /apps/<id>/ reverse-proxy route.
    expect(r.url).toBe("http://127.0.0.1:7007/apps/stitch/");
    expect(calls.register).toHaveLength(1);
    expect(calls.register[0].appId).toBe("stitch");
    expect(calls.register[0].kind).toBe("frontend");
    expect(calls.register[0].cwd).toBe(dir);
    expect(calls.register[0].command).toContain("next dev");
    expect(calls.register[0].command).toContain(`--port ${DEFAULT_BASE_PORT}`);
    expect(calls.register[0].port).toBe(DEFAULT_BASE_PORT);
  });

  it('dep-evidence detection (package.json "next" dep, no config file) needs no evidence file on disk', async () => {
    // Real Next projects don't require a next.config.* — detection's evidence
    // is `package.json dependency "next"`, which must not be treated as a
    // filename to verify.
    const dir = makeDir("dep-evidence");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "stitch", dependencies: { next: "^15.0.0" } }));
    const { deps, calls } = fakeDeps();
    const r = await finalizeFrameworkBuild(input(dir), deps);
    expect(r).toMatchObject({ handled: true, ok: true, framework: "nextjs" });
    expect(calls.register).toHaveLength(1);
  });

  it("registerServer:false (failed CLI run) returns the URL but never starts a dev server", async () => {
    const dir = makeDir("noserver");
    writeNextScaffold(dir);
    const { deps, calls } = fakeDeps();
    const r = await finalizeFrameworkBuild(input(dir, { registerServer: false }), deps);
    expect(r).toMatchObject({ handled: true, ok: true, url: "http://127.0.0.1:7007/apps/stitch/" });
    expect(calls.register).toHaveLength(0);
  });
});

describe("finalizeFrameworkBuild — failure shaping", () => {
  it("framework config without package.json → artifact_missing, never a false ok", async () => {
    const dir = makeDir("half");
    writeFileSync(join(dir, "next.config.js"), "export default {};\n");
    const { deps, calls } = fakeDeps();
    const r = await finalizeFrameworkBuild(input(dir), deps);
    expect(r).toMatchObject({ handled: true, ok: false, code: "artifact_missing" });
    if (!r.handled || r.ok) return;
    expect(r.message).toContain("nextjs");
    expect(r.message).toContain("package.json");
    expect(calls.register).toHaveLength(0);
  });

  it("registerDevServer failure → dev_server_failed carrying the register error", async () => {
    const dir = makeDir("regfail");
    writeNextScaffold(dir);
    const { deps } = fakeDeps({ registerResult: { ok: false, error: "start failed: spawn ENOENT" } });
    const r = await finalizeFrameworkBuild(input(dir), deps);
    expect(r).toMatchObject({ handled: true, ok: false, code: "dev_server_failed" });
    if (!r.handled || r.ok) return;
    expect(r.message).toContain("spawn ENOENT");
  });
});

describe("finalizeFrameworkBuild — dev-port allocation", () => {
  it("skips other records' ports, the LAX port itself, and OS-bound ports", async () => {
    const dir = makeDir("alloc");
    writeNextScaffold(dir);
    const laxPort = DEFAULT_BASE_PORT + 1;
    const { deps, calls } = fakeDeps({
      records: [record("other-app", DEFAULT_BASE_PORT)],       // base held by another app's record
      bound: (p) => p === DEFAULT_BASE_PORT + 2,               // base+2 bound on the box
    });
    const r = await finalizeFrameworkBuild(input(dir, { laxPort: String(laxPort) }), deps);
    // base taken, base+1 is LAX, base+2 bound → base+3.
    expect(calls.register).toHaveLength(1);
    expect(calls.register[0].port).toBe(DEFAULT_BASE_PORT + 3);
    expect(calls.register[0].command).toContain(`--port ${DEFAULT_BASE_PORT + 3}`);
    // The user-facing URL stays on the LAX proxy port, not the dev port.
    expect(r).toMatchObject({ handled: true, ok: true, url: `http://127.0.0.1:${laxPort}/apps/stitch/` });
  });

  it("every port busy → the probe walk stops at MAX_PORT_PROBES and hands back the last candidate", async () => {
    // Pathological all-ports-busy box: the walk must not spin forever on
    // portBound execs. Each of the 20 probes fails and advances the port,
    // so past the cap pickDevPort returns base+20 unconditionally — the
    // genuine collision surfaces via the dev server's startup verification.
    const dir = makeDir("cap");
    writeNextScaffold(dir);
    const { deps, calls } = fakeDeps({ bound: () => true });
    await finalizeFrameworkBuild(input(dir), deps);
    expect(calls.register).toHaveLength(1);
    expect(calls.register[0].port).toBe(DEFAULT_BASE_PORT + 20);
    expect(calls.register[0].command).toContain(`--port ${DEFAULT_BASE_PORT + 20}`);
  });

  it("a rebuild reuses its own record's port even when the probe reports it bound", async () => {
    // registerDevServer restarts the record's session, so its port isn't a
    // collision — grabbing a fresh port per rebuild would leak one per build.
    const dir = makeDir("rebuild");
    writeNextScaffold(dir);
    const { deps, calls } = fakeDeps({
      records: [record("stitch", DEFAULT_BASE_PORT + 10)],
      bound: () => true,
    });
    await finalizeFrameworkBuild(input(dir), deps);
    expect(calls.register).toHaveLength(1);
    expect(calls.register[0].port).toBe(DEFAULT_BASE_PORT + 10);
  });
});

/** Vite SPA scaffold (bare "vite" dep, no metaframework) — the only tier that
 *  takes the static-build finalize path. */
function writeViteScaffold(dir: string): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "stitch", private: true,
    scripts: { dev: "vite", build: "tsc -b && vite build" },
    devDependencies: { vite: "^7.0.0" },
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
  }, null, 2));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.tsx"), "export {}\n");
}

describe("finalizeFrameworkBuild — static-build target", () => {
  it("Vite SPA + runTarget static-build → builds dist/, writes the marker, forgets the dev server, registers NONE", async () => {
    const dir = makeDir("vite-static");
    writeViteScaffold(dir);
    const { deps, calls } = fakeDeps();
    const r = await finalizeFrameworkBuild(input(dir, { runTarget: "static-build" }), deps);
    expect(r).toMatchObject({ handled: true, ok: true, framework: "vite", mode: "static-build" });
    if (!r.handled || !r.ok) return;
    expect(r.url).toBe("http://127.0.0.1:7007/apps/stitch/");
    // Built the static bundle, never started a dev server.
    expect(calls.staticBuild).toEqual([{ appDir: dir, framework: "vite" }]);
    expect(calls.register).toHaveLength(0);
    // Forgot any dev server the model started during the build.
    expect(calls.stop).toEqual([{ appId: "stitch", forget: true }]);
    // Marker on disk so the request handler serves dist/ (no dev server).
    expect(readRunTargetManifest(dir)).toEqual({ mode: "static-build", distDir: "dist", framework: "vite" });
  });

  it("default runTarget (dev-server) leaves a Vite SPA on the dev server — no static build, no marker", async () => {
    const dir = makeDir("vite-dev");
    writeViteScaffold(dir);
    const { deps, calls } = fakeDeps();
    const r = await finalizeFrameworkBuild(input(dir), deps);   // runTarget omitted → dev-server
    expect(r).toMatchObject({ handled: true, ok: true, framework: "vite", mode: "dev-server" });
    expect(calls.staticBuild).toHaveLength(0);
    expect(calls.register).toHaveLength(1);
    expect(readRunTargetManifest(dir)).toBeNull();
  });

  it("static-build requested for a NON-static framework (Next) → ignored, stays on the dev server", async () => {
    // Only Vite is static-buildable; SSR frameworks keep the dev-server path
    // even when static-build is requested.
    const dir = makeDir("next-static-req");
    writeNextScaffold(dir);
    const { deps, calls } = fakeDeps();
    const r = await finalizeFrameworkBuild(input(dir, { runTarget: "static-build" }), deps);
    expect(r).toMatchObject({ handled: true, ok: true, framework: "nextjs", mode: "dev-server" });
    expect(calls.staticBuild).toHaveLength(0);
    expect(calls.register).toHaveLength(1);
  });

  it("static build FAILS → falls back to the dev server, carries a visible note, writes no marker", async () => {
    const dir = makeDir("vite-buildfail");
    writeViteScaffold(dir);
    const { deps, calls } = fakeDeps({ staticResult: { ok: false, error: "vite build exited 1: Rollup failed to resolve import" } });
    const r = await finalizeFrameworkBuild(input(dir, { runTarget: "static-build" }), deps);
    expect(r).toMatchObject({ handled: true, ok: true, framework: "vite", mode: "dev-server" });
    if (!r.handled || !r.ok) return;
    expect(r.note).toContain("static build failed");
    expect(r.note).toContain("Rollup failed to resolve import");
    expect(calls.staticBuild).toHaveLength(1);
    expect(calls.register).toHaveLength(1);   // degraded to a real dev server
    expect(calls.stop).toHaveLength(0);       // no marker → nothing forgotten
    expect(readRunTargetManifest(dir)).toBeNull();
  });
});

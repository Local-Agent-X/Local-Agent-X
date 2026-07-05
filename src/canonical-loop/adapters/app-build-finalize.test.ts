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

function fakeDeps(opts: {
  records?: DevServerRecord[];
  bound?: (port: number) => boolean;
  registerResult?: RegisterResult;
} = {}): { deps: FinalizeFrameworkDeps; calls: RegisterCall[] } {
  const calls: RegisterCall[] = [];
  const deps: FinalizeFrameworkDeps = {
    registerDevServer: (input) => {
      calls.push(input);
      return opts.registerResult ?? {
        ok: true, connector: `dev-${input.appId}`, sessionId: "sess-1",
        port: input.port, cwd: input.cwd ?? "", restarted: false, kind: input.kind ?? "backend",
      };
    },
    listDevServerRecords: () => opts.records ?? [],
    portBound: opts.bound ?? (() => false),
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
    expect(calls).toHaveLength(0);
  });

  it("unknown (empty) dir → handled:false", async () => {
    const { deps, calls } = fakeDeps();
    expect(await finalizeFrameworkBuild(input(makeDir("empty")), deps)).toEqual({ handled: false });
    expect(calls).toHaveLength(0);
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
    expect(calls).toHaveLength(1);
    expect(calls[0].appId).toBe("stitch");
    expect(calls[0].kind).toBe("frontend");
    expect(calls[0].cwd).toBe(dir);
    expect(calls[0].command).toContain("next dev");
    expect(calls[0].command).toContain(`--port ${DEFAULT_BASE_PORT}`);
    expect(calls[0].port).toBe(DEFAULT_BASE_PORT);
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
    expect(calls).toHaveLength(1);
  });

  it("registerServer:false (failed CLI run) returns the URL but never starts a dev server", async () => {
    const dir = makeDir("noserver");
    writeNextScaffold(dir);
    const { deps, calls } = fakeDeps();
    const r = await finalizeFrameworkBuild(input(dir, { registerServer: false }), deps);
    expect(r).toMatchObject({ handled: true, ok: true, url: "http://127.0.0.1:7007/apps/stitch/" });
    expect(calls).toHaveLength(0);
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
    expect(calls).toHaveLength(0);
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
    expect(calls).toHaveLength(1);
    expect(calls[0].port).toBe(DEFAULT_BASE_PORT + 3);
    expect(calls[0].command).toContain(`--port ${DEFAULT_BASE_PORT + 3}`);
    // The user-facing URL stays on the LAX proxy port, not the dev port.
    expect(r).toMatchObject({ handled: true, ok: true, url: `http://127.0.0.1:${laxPort}/apps/stitch/` });
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
    expect(calls).toHaveLength(1);
    expect(calls[0].port).toBe(DEFAULT_BASE_PORT + 10);
  });
});

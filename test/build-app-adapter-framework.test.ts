/**
 * Framework-completion seam of the CLI app-build adapter — regression for
 * the live bug where a Next.js build "succeeded" but the user got
 * {"error":"Not found"}: the terminal unconditionally required a root
 * index.html (so every framework build died as artifact_missing — or, when
 * index.html happened to exist, shipped an /apps/<name>/index.html URL that
 * 404s at the static handler), and no frontend dev server was ever
 * registered for the /apps/<id>/ reverse proxy to start.
 *
 * Sibling to build-app-adapter.test.ts (same fixture/report idiom; split
 * file so neither crosses the 400-LOC bar). Seams: the adapter's cliRunner
 * (no CLI subprocess) + finalizeDeps (no dev-server records/ports/processes).
 * finalizeFrameworkBuild's own unit contract lives in
 * src/canonical-loop/adapters/app-build-finalize.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterReport, TurnInput } from "../src/canonical-loop/adapter-contract.js";
import {
  createAppBuildAdapter,
  type AppBuildAdapterOptions,
  type CliBuildRunner,
} from "../src/canonical-loop/adapters/app-build-adapter.js";
import type { FinalizeFrameworkDeps } from "../src/canonical-loop/adapters/app-build-finalize.js";
import type { AppSmokeGateRunner } from "../src/canonical-loop/adapters/app-build-verify-adapter.js";

// Stub the done-terminal headless smoke so no test launches a real browser;
// the gate's own contract is tested in test/app-build-smoke-gate.test.ts.
const passSmoke: AppSmokeGateRunner = async () => ({ verdict: "pass" });

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// The adapter reads LAX_PORT for the proxy URL — pin the default so the
// expected URLs are deterministic on boxes where a dev server exported it.
let prevLaxPort: string | undefined;
beforeEach(() => { prevLaxPort = process.env.LAX_PORT; delete process.env.LAX_PORT; });
afterEach(() => {
  if (prevLaxPort === undefined) delete process.env.LAX_PORT;
  else process.env.LAX_PORT = prevLaxPort;
});

/** Next-shaped appDir exactly as the live bug produced it: config + package.json
 *  with the next dep + app-router entry, NO index.html anywhere. */
function makeNextAppDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "appbuild-fw-next-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "next.config.js"), `const nextConfig = { basePath: "/apps/${name}" };\nexport default nextConfig;\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name,
    private: true,
    scripts: { dev: "next dev", build: "next build" },
    dependencies: { next: "^15.0.0", react: "^18.3.0", "react-dom": "^18.3.0" },
  }, null, 2));
  mkdirSync(join(dir, "src", "app"), { recursive: true });
  writeFileSync(join(dir, "src", "app", "page.tsx"), "export default function Page() {\n  return <main>frames</main>;\n}\n");
  return dir;
}

/** Flat-HTML appDir — same fixture markup as build-app-adapter.test.ts. */
function makeStaticAppDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "appbuild-fw-static-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><body>fixture</body></html>");
  return dir;
}

function makeEmptyAppDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "appbuild-fw-empty-"));
  tempDirs.push(dir);
  return dir;
}

function emptyTurnInput(opId = "op_app_build_fw_test", turnIdx = 0): TurnInput {
  return { opId, turnIdx, messages: [], tools: [] };
}

function collectReports(): { reports: AdapterReport[]; report: (r: AdapterReport) => void } {
  const reports: AdapterReport[] = [];
  return { reports, report: (r) => { reports.push(r); } };
}

type RegisterCall = { appId: string; command: string; port: number; cwd?: string; kind?: string };

function fakeFinalizeDeps(): { deps: FinalizeFrameworkDeps; calls: RegisterCall[] } {
  const calls: RegisterCall[] = [];
  const deps: FinalizeFrameworkDeps = {
    registerDevServer: (input) => {
      calls.push(input);
      return {
        ok: true, connector: `dev-${input.appId}`, sessionId: "sess-1",
        port: input.port, cwd: input.cwd ?? "", restarted: false, kind: input.kind ?? "backend",
      };
    },
    listDevServerRecords: () => [],
    portBound: () => false,
  };
  return { deps, calls };
}

function makeAdapter(over: Partial<AppBuildAdapterOptions> & Pick<AppBuildAdapterOptions, "appName" | "appDir" | "appUrl" | "cliRunner">) {
  return createAppBuildAdapter({
    strategy: "cli-subprocess",
    provider: "anthropic",
    prompt: "P",
    systemPrompt: "P",
    smokeGate: passSmoke,
    ...over,
  });
}

describe("CLI adapter terminal — framework (Next) completion [regression]", () => {
  it("a Next-shaped appDir completes as APP_READY on the /apps/<name>/ proxy URL with a frontend dev server registered — no artifact_missing", async () => {
    // Old terminal behavior this pins against: verifyWriteLanded(index.html)
    // unconditionally → artifact_missing error, terminalReason "error", no
    // dev server — the exact live failure.
    const appName = "ai-video-stitch-next";
    const appDir = makeNextAppDir(appName);
    const flatUrl = `http://127.0.0.1:7007/apps/${appName}/index.html`;   // what build-app.ts passes in
    const proxyUrl = `http://127.0.0.1:7007/apps/${appName}/`;
    // Realistic spawn-layer success content: the "Open:" line echoes the flat
    // appUrl the CLI was told, and the model's tail echoes its own dev URL.
    const cliRunner: CliBuildRunner = async () => ({
      content: `App built with Claude CLI!\n\nOpen: ${flatUrl}\n\nAPP_READY: http://localhost:3000`,
    });
    const { deps, calls } = fakeFinalizeDeps();
    // urlResolver simulates the record CliBuildAdapter's finalize persists — in
    // production the real resolver finds it, so the verify gate smokes it rather
    // than re-registering. Without this seam the real resolver sees no record
    // (the fake deps don't hit the store) and the gate would register a 2nd time.
    const adapter = await makeAdapter({ appName, appDir, appUrl: flatUrl, cliRunner, finalizeDeps: deps, urlResolver: async () => proxyUrl });

    const { reports, report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);

    // (a) NOT artifact_missing — the framework scaffold IS the artifact.
    expect(reports.filter(r => r.kind === "error")).toEqual([]);
    expect(result.terminalReason).toBe("done");

    // (b) frontend dev server registered for the app, in the app's dir, running next dev.
    expect(calls).toHaveLength(1);
    expect(calls[0].appId).toBe(appName);
    expect(calls[0].kind).toBe("frontend");
    expect(calls[0].cwd).toBe(appDir);
    expect(calls[0].command).toContain("next dev");

    // (c) APP_READY carries the proxy URL — trailing slash, no index.html —
    // in BOTH the providerState url and the finalized message content.
    const payload = result.providerState.providerPayload as Record<string, unknown>;
    expect(payload.url).toBe(proxyUrl);
    const finalized = reports.find(r => r.kind === "message_finalized");
    expect(finalized).toBeDefined();
    const text = finalized?.kind === "message_finalized"
      ? (finalized.message.content as { text: string }).text
      : "";
    expect(text).toContain(`APP_READY: ${proxyUrl}`);
    expect(text).toContain(`Open: ${proxyUrl}`);
    expect(text).not.toContain("index.html");            // stale flat URL fully rewritten
    expect(text).not.toContain("localhost:3000");        // model-claimed dev URL overridden

    // (d) framework surfaced for op-result inspection.
    expect(payload.framework).toBe("nextjs");
  });

  it("an empty appUrl skips the base-URL rewrite instead of corrupting the content [regression]", async () => {
    // Old behavior this pins against: content.split("") splits into every
    // character, so the join inserted the proxy URL between each one — the
    // finalized message became thousands of interleaved URL copies.
    const appName = "no-base-next";
    const appDir = makeNextAppDir(appName);
    const proxyUrl = `http://127.0.0.1:7007/apps/${appName}/`;
    const cliRunner: CliBuildRunner = async () => ({
      content: "App built with Claude CLI!\n\nAPP_READY: http://localhost:3000",
    });
    const { deps } = fakeFinalizeDeps();
    const adapter = await makeAdapter({ appName, appDir, appUrl: "", cliRunner, finalizeDeps: deps });
    const { reports, report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);
    expect(result.terminalReason).toBe("done");
    const finalized = reports.find(r => r.kind === "message_finalized");
    const text = finalized?.kind === "message_finalized"
      ? (finalized.message.content as { text: string }).text
      : "";
    // Prose survives contiguously — under the bug no two characters stayed adjacent.
    expect(text).toContain("App built with Claude CLI!");
    expect(text).toContain(`APP_READY: ${proxyUrl}`);
    expect(text).not.toContain("localhost:3000");
  });

  it("an incomplete framework scaffold (next.config.js, no package.json) fails artifact_missing — never a false APP_READY", async () => {
    const appDir = makeEmptyAppDir();
    writeFileSync(join(appDir, "next.config.js"), "export default {};\n");
    const cliRunner: CliBuildRunner = async ({ appUrl }) => ({ content: `APP_READY: ${appUrl}` });
    const { deps, calls } = fakeFinalizeDeps();
    const adapter = await makeAdapter({
      appName: "half-next", appDir, appUrl: "http://127.0.0.1:7007/apps/half-next/index.html",
      cliRunner, finalizeDeps: deps,
    });
    const { reports, report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);
    expect(result.terminalReason).toBe("error");
    expect(reports.some(r => r.kind === "error" && r.code === "artifact_missing")).toBe(true);
    expect(reports.some(r => r.kind === "message_finalized")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a failed CLI run (isError) on a framework dir terminates as error and registers NO dev server", async () => {
    const appDir = makeNextAppDir("failed-next");
    const cliRunner: CliBuildRunner = async () => ({ content: "Claude CLI build failed: exit code 1", isError: true });
    const { deps, calls } = fakeFinalizeDeps();
    const adapter = await makeAdapter({
      appName: "failed-next", appDir, appUrl: "http://127.0.0.1:7007/apps/failed-next/index.html",
      cliRunner, finalizeDeps: deps,
    });
    const { report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);
    expect(result.terminalReason).toBe("error");
    expect(calls).toHaveLength(0);
  });
});

describe("CLI adapter terminal — static completion unchanged by the framework branch", () => {
  it("flat-HTML appDir keeps the /index.html APP_READY URL and registers no dev server", async () => {
    const appDir = makeStaticAppDir();
    const flatUrl = "http://127.0.0.1:7007/apps/memory-cards/index.html";
    const cliRunner: CliBuildRunner = async ({ appUrl }) => ({ content: `APP_READY: ${appUrl}` });
    const { deps, calls } = fakeFinalizeDeps();
    const adapter = await makeAdapter({
      appName: "memory-cards", appDir, appUrl: flatUrl, cliRunner, finalizeDeps: deps,
    });
    const { reports, report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);
    expect(result.terminalReason).toBe("done");
    const payload = result.providerState.providerPayload as Record<string, unknown>;
    expect(payload.url).toBe(flatUrl);
    expect(payload.framework).toBeUndefined();
    const finalized = reports.find(r => r.kind === "message_finalized");
    const text = finalized?.kind === "message_finalized"
      ? (finalized.message.content as { text: string }).text
      : "";
    expect(text).toContain(`APP_READY: ${flatUrl}`);
    expect(calls).toHaveLength(0);
  });

  it("missing index.html on a non-framework appDir still fails artifact_missing (the gate survived)", async () => {
    const appDir = makeEmptyAppDir();
    const cliRunner: CliBuildRunner = async () => ({ content: "wrote nothing" });
    const { deps, calls } = fakeFinalizeDeps();
    const adapter = await makeAdapter({
      appName: "ghost", appDir, appUrl: "http://127.0.0.1:7007/apps/ghost/index.html",
      cliRunner, finalizeDeps: deps,
    });
    const { reports, report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);
    expect(result.terminalReason).toBe("error");
    expect(reports.some(r => r.kind === "error" && r.code === "artifact_missing")).toBe(true);
    expect(reports.some(r => r.kind === "message_finalized")).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

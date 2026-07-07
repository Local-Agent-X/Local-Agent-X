/**
 * See-before-done smoke gate at the app_build done terminal — regression for
 * the maze-escape-3d class: an exception-free but semantically broken app
 * passed every static scan and shipped as APP_READY on the builder's own
 * attestation. The verify wrapper now observes the page running (headless
 * load → console errors / mount check) before letting "done" stand.
 *
 * The AppBuildVerifyAdapter is exercised with a stubbed inner adapter and a
 * stubbed gate runner — the wrapper's routing (fail→error terminal,
 * skipped→done + warning, pass→done) is the contract under test, not
 * Playwright. The real runner's env-degradation (missing chromium → skipped,
 * never a build failure) is covered by the launch-throw path in runAppSmokeGate.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReport, TurnInput } from "../src/canonical-loop/adapter-contract.js";
import {
  AppBuildVerifyAdapter,
  type AppSmokeGateOutcome,
} from "../src/canonical-loop/adapters/app-build-verify-adapter.js";

const tempDirs: string[] = [];
function makeStaticAppDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-gate-test-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><body><canvas width='960' height='640'></canvas></body></html>");
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    try { rmSync(tempDirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const doneInner: Adapter = {
  name: "stub",
  version: "1.0.0",
  runTurn: async () => ({
    providerState: { adapterName: "stub", adapterVersion: "1.0.0", providerPayload: {} },
    terminalReason: "done" as const,
  }),
  abort: async () => { /* no-op */ },
};

function turnInput(): TurnInput {
  return { opId: "op_smoke_test", turnIdx: 0, messages: [], tools: [] };
}

function collect(): { reports: AdapterReport[]; report: (r: AdapterReport) => void } {
  const reports: AdapterReport[] = [];
  return { reports, report: (r) => { reports.push(r); } };
}

async function runWith(outcome: AppSmokeGateOutcome) {
  const appDir = makeStaticAppDir();
  const gateCalls: string[] = [];
  const adapter = new AppBuildVerifyAdapter(doneInner, appDir, undefined, async (dir) => {
    gateCalls.push(dir);
    return outcome;
  });
  const { reports, report } = collect();
  const result = await adapter.runTurn(turnInput(), report);
  return { result, reports, gateCalls, appDir };
}

describe("AppBuildVerifyAdapter — see-before-done smoke gate", () => {
  it("a failed smoke converts the builder's done into an error terminal — attestation doesn't ship [regression]", async () => {
    const { result, reports, gateCalls, appDir } = await runWith({
      verdict: "fail",
      detail: "page renders NOTHING — no canvas painted",
    });
    expect(gateCalls).toEqual([appDir]);
    expect(result.terminalReason).toBe("error");
    const err = reports.find(r => r.kind === "error");
    expect(err).toMatchObject({ code: "app_smoke_failed" });
    expect((err as { message: string }).message).toContain("renders NOTHING");
  });

  it("a skipped smoke (no chromium on this machine) keeps done and surfaces a warning — env problems never fail builds", async () => {
    const { result, reports } = await runWith({ verdict: "skipped", detail: "headless smoke unavailable: no browser" });
    expect(result.terminalReason).toBe("done");
    const chunk = reports.find(r => r.kind === "stream_chunk");
    expect(chunk && (chunk as { body: { delta: string } }).body.delta).toContain("smoke gate skipped");
  });

  it("a passing smoke keeps done and reports the render evidence", async () => {
    const { result, reports } = await runWith({ verdict: "pass", screenshotPath: "/x/.lax-build/smoke.png" });
    expect(result.terminalReason).toBe("done");
    const chunk = reports.find(r => r.kind === "stream_chunk");
    expect(chunk && (chunk as { body: { delta: string } }).body.delta).toContain("smoke passed");
  });

  it("an error terminal from the inner adapter passes through without running the gate", async () => {
    const errorInner: Adapter = {
      ...doneInner,
      runTurn: async () => ({
        providerState: { adapterName: "stub", adapterVersion: "1.0.0", providerPayload: {} },
        terminalReason: "error" as const,
      }),
    };
    let gateRan = false;
    const adapter = new AppBuildVerifyAdapter(errorInner, makeStaticAppDir(), undefined, async () => {
      gateRan = true;
      return { verdict: "pass" };
    });
    const { report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("error");
    expect(gateRan).toBe(false);
  });
});

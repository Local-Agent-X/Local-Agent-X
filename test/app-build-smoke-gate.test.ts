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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AdapterReport, TurnInput } from "../src/canonical-loop/adapter-contract.js";
import {
  AppBuildVerifyAdapter,
  VERIFY_EVIDENCE_MARKER,
  type AppSmokeGateOutcome,
  type AppVisionJudge,
} from "../src/canonical-loop/adapters/app-build-verify-adapter.js";

const tempDirs: string[] = [];
function makeStaticAppDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-gate-test-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><html><body><canvas width='960' height='640'></canvas></body></html>");
  return dir;
}
/** Drop real evidence PNG stubs so existsSync-gated image attachment fires. */
function seedScreenshots(appDir: string): { shot1: string; shot2: string } {
  const dir = join(appDir, ".lax-build");
  mkdirSync(dir, { recursive: true });
  const shot1 = join(dir, "smoke.png");
  const shot2 = join(dir, "smoke-2.png");
  writeFileSync(shot1, "png-bytes-1");
  writeFileSync(shot2, "png-bytes-2");
  return { shot1, shot2 };
}
function evidenceMessageFrom(reports: AdapterReport[]): { text: string; images?: Array<{ name: string; filePath: string }> } | null {
  const fin = reports.find((r): r is Extract<AdapterReport, { kind: "message_finalized" }> =>
    r.kind === "message_finalized" &&
    (r.message.content as { text?: string })?.text?.startsWith(VERIFY_EVIDENCE_MARKER) === true);
  if (!fin) return null;
  return fin.message.content as { text: string; images?: Array<{ name: string; filePath: string }> };
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
  const gateCalls: Array<{ appDir: string; url?: string; mode: string }> = [];
  const adapter = new AppBuildVerifyAdapter(doneInner, appDir, undefined, async (spec) => {
    gateCalls.push(spec);
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
    expect(gateCalls).toEqual([{ appDir, url: undefined, mode: "strict" }]);
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

  it("a failed smoke ALSO emits a marker evidence user-message carrying the screenshots [regression]", async () => {
    const appDir = makeStaticAppDir();
    const { shot1, shot2 } = seedScreenshots(appDir);
    const adapter = new AppBuildVerifyAdapter(doneInner, appDir, undefined, async (): Promise<AppSmokeGateOutcome> => ({
      verdict: "fail",
      detail: "clicking its primary action threw 3 console error(s)",
      screenshotPath: shot1,
      interactionScreenshotPath: shot2,
    }));
    const { reports, report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("error");
    const evidence = evidenceMessageFrom(reports);
    expect(evidence).not.toBeNull();
    expect(evidence!.text).toContain("primary action threw 3 console error(s)");
    expect(evidence!.images?.map(i => i.filePath)).toEqual([shot1, shot2]);
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

describe("AppBuildVerifyAdapter — vision judge tier", () => {
  function judgedAdapter(judge: AppVisionJudge, brief = "a 3D maze escape game") {
    const appDir = makeStaticAppDir();
    const { shot1, shot2 } = seedScreenshots(appDir);
    const adapter = new AppBuildVerifyAdapter(
      doneInner, appDir, undefined,
      async () => ({ verdict: "pass", screenshotPath: shot1, interactionScreenshotPath: shot2 }),
      { brief, judge },
    );
    return { adapter, shot1, shot2 };
  }

  it("a judge rejection flips done into error with the judge's reason AND screenshot evidence [regression]", async () => {
    const { adapter, shot1, shot2 } = judgedAdapter(async () => ({ ok: false, reason: "black screen after Start — nothing resembling a maze" }));
    const { reports, report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("error");
    const err = reports.find(r => r.kind === "error");
    expect(err).toMatchObject({ code: "app_vision_rejected" });
    expect((err as { message: string }).message).toContain("black screen after Start");
    const evidence = evidenceMessageFrom(reports);
    expect(evidence!.images?.map(i => i.filePath)).toEqual([shot1, shot2]);
  });

  it("judge sees BOTH screenshots and the brief", async () => {
    const calls: Array<{ paths: string[]; brief: string }> = [];
    const { adapter, shot1, shot2 } = judgedAdapter(async (paths, brief) => {
      calls.push({ paths, brief });
      return { ok: true, reason: "looks like a maze" };
    });
    const { report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("done");
    expect(calls).toEqual([{ paths: [shot1, shot2], brief: "a 3D maze escape game" }]);
  });

  it("no verdict available (null) keeps done — a lost free check never fails a build", async () => {
    const { adapter } = judgedAdapter(async () => null);
    const { reports, report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("done");
    const chunks = reports.filter(r => r.kind === "stream_chunk").map(r => (r as { body: { delta: string } }).body.delta).join("");
    expect(chunks).toContain("vision judge unavailable");
  });

  it("no brief → judge never runs (it can't answer 'what was asked' without the ask)", async () => {
    let judgeRan = false;
    const { adapter } = judgedAdapter(async () => { judgeRan = true; return { ok: false, reason: "x" }; }, "");
    const { report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("done");
    expect(judgeRan).toBe(false);
  });

  it("hard-signal console chatter (judgeNotes) rides into the judge's brief", async () => {
    const appDir = makeStaticAppDir();
    const { shot1 } = seedScreenshots(appDir);
    const briefs: string[] = [];
    const adapter = new AppBuildVerifyAdapter(
      doneInner, appDir, undefined,
      async () => ({ verdict: "pass" as const, screenshotPath: shot1, judgeNotes: "The page logged 2 console error(s)" }),
      { brief: "a maze game", judge: async (_paths, brief) => { briefs.push(brief); return { ok: true, reason: "fine" }; } },
    );
    const { report } = collect();
    await adapter.runTurn(turnInput(), report);
    expect(briefs[0]).toContain("a maze game");
    expect(briefs[0]).toContain("The page logged 2 console error(s)");
  });
});

describe("AppBuildVerifyAdapter — framework tiers smoke the LIVE dev server", () => {
  function makeViteAppDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "smoke-gate-vite-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { vite: "^5" } }));
    writeFileSync(join(dir, "vite.config.js"), "export default {}");
    return dir;
  }

  it("a detected framework build smokes its dev-server URL in hard-signals mode [regression: used to skip the smoke tier]", async () => {
    const appDir = makeViteAppDir();
    const gateCalls: Array<{ appDir: string; url?: string; mode: string }> = [];
    const adapter = new AppBuildVerifyAdapter(
      doneInner, appDir, undefined,
      async (spec) => { gateCalls.push(spec); return { verdict: "pass" as const }; },
      { urlResolver: async (appName) => `http://127.0.0.1:7007/apps/${appName}/` },
    );
    const { report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("done");
    expect(gateCalls).toEqual([{
      appDir,
      url: `http://127.0.0.1:7007/apps/${appDir.split(/[\\/]/).pop()}/`,
      mode: "hard-signals",
    }]);
  });

  it("frontend-spa tier with a REAL scaffold smokes the dev server (the faked-check still fires first on fakes)", async () => {
    const appDir = makeViteAppDir();
    const gateCalls: Array<{ mode: string; url?: string }> = [];
    const adapter = new AppBuildVerifyAdapter(
      doneInner, appDir, "frontend-spa",
      async (spec) => { gateCalls.push({ mode: spec.mode, url: spec.url }); return { verdict: "pass" as const }; },
      { urlResolver: async () => "http://127.0.0.1:7007/apps/x/" },
    );
    const { report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("done");
    expect(gateCalls).toEqual([{ mode: "hard-signals", url: "http://127.0.0.1:7007/apps/x/" }]);
  });

  // The in-canonical path never registers a dev server (only CliBuildAdapter
  // does), so a framework build there arrives with no record. The gate must NOT
  // skip — that's how the black page shipped. It registers the
  // detected framework's server and smokes the live URL.
  it("no dev-server record → registers the framework's server and smokes it, never skips", async () => {
    const appDir = makeViteAppDir();
    const gateCalls: Array<{ url?: string; mode: string }> = [];
    const registered: Array<{ appId: string; kind?: string }> = [];
    const adapter = new AppBuildVerifyAdapter(
      doneInner, appDir, undefined,
      async (spec) => { gateCalls.push({ url: spec.url, mode: spec.mode }); return { verdict: "pass" as const }; },
      {
        urlResolver: async () => null,
        finalizeDeps: {
          registerDevServer: (input) => { registered.push({ appId: input.appId, kind: input.kind }); return { ok: true, connector: "dev-x", sessionId: "s1", port: input.port, cwd: input.cwd ?? appDir, restarted: false, kind: "frontend" }; },
          listDevServerRecords: () => [],
          portBound: () => false,
        },
      },
    );
    const { report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    const name = appDir.split(/[\\/]/).pop();
    expect(result.terminalReason).toBe("done");
    expect(registered).toEqual([{ appId: name, kind: "frontend" }]);
    expect(gateCalls).toEqual([{ url: `http://127.0.0.1:7007/apps/${name}/`, mode: "hard-signals" }]);
  });

  // No record AND registration can't produce a servable URL → the build has
  // nothing live at /apps/<id>/ and renders blank. That's a FAIL, not a silent
  // pass — the exact hole the in-canonical black-page build fell through.
  it("no dev-server record and registration fails → flips done to error, never a silent pass", async () => {
    const appDir = makeViteAppDir();
    let gateRan = false;
    const adapter = new AppBuildVerifyAdapter(
      doneInner, appDir, undefined,
      async () => { gateRan = true; return { verdict: "pass" as const }; },
      {
        urlResolver: async () => null,
        finalizeDeps: {
          registerDevServer: () => ({ ok: false, error: "port bind failed" }),
          listDevServerRecords: () => [],
          portBound: () => false,
        },
      },
    );
    const { reports, report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("error");
    expect(gateRan).toBe(false);
    const err = reports.find(r => r.kind === "error");
    expect(err).toMatchObject({ code: "app_smoke_failed" });
    expect((err as { message: string }).message).toContain("no servable dev server");
  });

  // A Next app carrying a serving vite.config is the hybrid: one
  // config is dead and the page is blank. The gate rejects it BEFORE smoking.
  it("a two-framework hybrid (Next + serving vite.config) flips done to error, never smokes", async () => {
    const appDir = mkdtempSync(join(tmpdir(), "smoke-gate-hybrid-"));
    tempDirs.push(appDir);
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ dependencies: { next: "latest", vite: "latest" } }));
    writeFileSync(join(appDir, "next.config.js"), "export default { basePath: '/apps/x' };");
    writeFileSync(join(appDir, "vite.config.js"), "export default { base: '/apps/x/', server: { port: 5178 } };");
    let gateRan = false;
    const adapter = new AppBuildVerifyAdapter(
      doneInner, appDir, "frontend-spa",
      async () => { gateRan = true; return { verdict: "pass" as const }; },
      { urlResolver: async () => "http://127.0.0.1:7007/apps/x/" },
    );
    const { reports, report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("error");
    expect(gateRan).toBe(false);
    const err = reports.find(r => r.kind === "error");
    expect(err).toMatchObject({ code: "framework_hybrid" });
    expect((err as { message: string }).message).toContain("Pick exactly one framework");
  });

  it("a dev-server smoke failure flips done to error with evidence, same as static", async () => {
    const appDir = makeViteAppDir();
    const adapter = new AppBuildVerifyAdapter(
      doneInner, appDir, undefined,
      async () => ({ verdict: "fail" as const, detail: "dev server never became ready at http://127.0.0.1:7007/apps/x/ (last: HTTP 503)" }),
      { urlResolver: async () => "http://127.0.0.1:7007/apps/x/" },
    );
    const { reports, report } = collect();
    const result = await adapter.runTurn(turnInput(), report);
    expect(result.terminalReason).toBe("error");
    const err = reports.find(r => r.kind === "error");
    expect(err).toMatchObject({ code: "app_smoke_failed" });
    expect((err as { message: string }).message).toContain("never became ready");
  });
});

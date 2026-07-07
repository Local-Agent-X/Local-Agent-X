/**
 * Build-terminal verify gate for app_build ops — wraps the real build adapter
 * (either strategy) and gates a clean completion. Two layers, both enforced on
 * every model and strategy at this one chokepoint (teaching alone is a request
 * a strong-priored model can override):
 *
 *   1. Static scans (app-build-verify.ts): faked frontend, startup errors,
 *      raw cross-origin fetch, unverified native parity.
 *   2. Headless smoke (see-before-done): actually LOAD the built page and
 *      observe it. An app with wrong-but-exception-free logic (broken canvas
 *      math, blank mount, console explosion) passes every static scan and
 *      used to ship as APP_READY on the builder's own say-so — this is the
 *      layer that observes behavior instead of trusting attestation. A
 *      render-evidence PNG lands in .lax-build/smoke.png either way.
 *
 * A smoke that can't run (missing chromium binary on this machine) SKIPS with
 * a warning — an environment problem is never a build verdict.
 */
import { join, resolve } from "node:path";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import {
  scanAppForBlockedFetch, formatBlockedFetchError,
  scanAppForStartupErrors, formatStartupErrors,
  scanAppForUnverifiedNativeParity, formatUnverifiedNativeParity,
  scanAppForFakedFrontend, formatFakedFrontend,
} from "../../tools/app-build-verify.js";
import type { AppTier } from "../../tools/app-tier.js";
import { detectFramework } from "../../tools/framework-detect.js";
import { smokeUrl } from "../../auto-build/scenario-scorer/smoke.js";

const SMOKE_LOAD_TIMEOUT_MS = 30_000;

export interface AppSmokeGateOutcome {
  verdict: "pass" | "fail" | "skipped";
  /** fail → actionable error for the fixer; skipped → why the gate couldn't run. */
  detail?: string;
  /** Render-evidence PNG, when captured. */
  screenshotPath?: string;
}

/** Injectable so adapter tests don't launch a real browser. */
export type AppSmokeGateRunner = (appDir: string) => Promise<AppSmokeGateOutcome>;

/**
 * Load the built index.html headlessly (file:// like the chunk-review
 * build-exec gate — no server dependency, no favicon-fetch noise) and judge:
 * load error / console errors / nothing mounted → fail with a message the
 * next build attempt can act on.
 */
export const runAppSmokeGate: AppSmokeGateRunner = async (appDir) => {
  const entry = resolve(appDir, "index.html");
  const fileUrl = "file://" + entry.replace(/\\/g, "/");
  const screenshotPath = join(appDir, ".lax-build", "smoke.png");
  let smoke;
  try {
    smoke = await smokeUrl(fileUrl, SMOKE_LOAD_TIMEOUT_MS, undefined, { screenshotPath });
  } catch (e) {
    return { verdict: "skipped", detail: `headless smoke unavailable: ${(e as Error).message.slice(0, 200)}` };
  }
  const evidence = smoke.screenshotPath
    ? ` A screenshot of what the app actually rendered is saved at ${smoke.screenshotPath} — read/view it before claiming a fix.`
    : "";
  if (smoke.loadError) {
    return {
      verdict: "fail", screenshotPath: smoke.screenshotPath,
      detail: `The built page failed to load headlessly (${smoke.loadError}). It was reported APP_READY but does not open.${evidence}`,
    };
  }
  if (smoke.consoleErrors.length > 0) {
    return {
      verdict: "fail", screenshotPath: smoke.screenshotPath,
      detail:
        `The built page throws ${smoke.consoleErrors.length} console error(s) on load — it was reported APP_READY but is broken at runtime. ` +
        `First: "${smoke.consoleErrors[0]}".${evidence}`,
    };
  }
  if (!smoke.rootMounted) {
    return {
      verdict: "fail", screenshotPath: smoke.screenshotPath,
      detail:
        `The built page loads with no console errors but renders NOTHING — no canvas painted and no mount root has content. ` +
        `It was reported APP_READY but shows an empty page.${evidence}`,
    };
  }
  return { verdict: "pass", screenshotPath: smoke.screenshotPath };
};

export class AppBuildVerifyAdapter implements Adapter {
  constructor(
    private readonly inner: Adapter,
    private readonly appDir: string,
    private readonly tier?: AppTier,
    private readonly smokeGate: AppSmokeGateRunner = runAppSmokeGate,
  ) {}
  get name(): string { return this.inner.name; }
  get version(): string { return this.inner.version; }

  async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
    const result = await this.inner.runTurn(input, report);
    if (result.terminalReason !== "done") return result;
    // A frontend-spa build that shipped a static page instead of a real project
    // FAKED it — the invariant that closes the live-Vite-fake class. Tier-gated
    // so it's inert on every other build. A startup error (no HTML entry) on a
    // real-built SPA is expected pre-dev-server, so the faked check supersedes it.
    if (this.tier === "frontend-spa") {
      const fake = scanAppForFakedFrontend(this.appDir);
      if (fake.faked) {
        report({ kind: "error", code: "faked_frontend_build", message: formatFakedFrontend(fake.reason), retryable: false });
        return { ...result, terminalReason: "error" };
      }
      // Real project present — skip the static-HTML startup/fetch scans below
      // (a Vite app's index.html legitimately points at /src/main.jsx, which
      // those scans would misread as a missing-file or cross-origin smell).
      return result;
    }
    // On-disk truth supersedes the prompt-classified tier: a real framework
    // scaffold (Next/Vite/…) has no static HTML entry, so the scans below
    // would falsely reject it — same reasoning as the frontend-spa skip.
    const detected = detectFramework(this.appDir).framework;
    if (detected !== "static" && detected !== "unknown") return result;
    const { errors } = scanAppForStartupErrors(this.appDir);
    const { violations } = scanAppForBlockedFetch(this.appDir);
    const { violations: parity } = scanAppForUnverifiedNativeParity(this.appDir);
    if (errors.length > 0 || violations.length > 0 || parity.length > 0) {
      // Startup errors first — a blank-on-load app is the more fundamental break.
      const parts: string[] = [];
      if (errors.length > 0) parts.push(formatStartupErrors(errors));
      if (violations.length > 0) parts.push(formatBlockedFetchError(violations));
      if (parity.length > 0) parts.push(formatUnverifiedNativeParity(parity));
      const code = errors.length > 0 ? "app_startup_error"
        : violations.length > 0 ? "blocked_external_fetch"
        : "unverified_native_parity";
      report({ kind: "error", code, message: parts.join("\n\n"), retryable: false });
      return { ...result, terminalReason: "error" };
    }
    // Static scans clean — now observe the page actually running.
    const smoke = await this.smokeGate(this.appDir);
    if (smoke.verdict === "fail") {
      report({ kind: "error", code: "app_smoke_failed", message: smoke.detail ?? "smoke failed", retryable: false });
      return { ...result, terminalReason: "error" };
    }
    if (smoke.verdict === "skipped") {
      report({ kind: "stream_chunk", body: { delta: `[verify] smoke gate skipped: ${smoke.detail}\n` } });
    } else {
      report({ kind: "stream_chunk", body: { delta: `[verify] smoke passed — page loaded, mounted, 0 console errors${smoke.screenshotPath ? ` (evidence: ${smoke.screenshotPath})` : ""}\n` } });
    }
    return result;
  }

  abort(reason?: unknown): Promise<void> { return this.inner.abort(reason); }
}

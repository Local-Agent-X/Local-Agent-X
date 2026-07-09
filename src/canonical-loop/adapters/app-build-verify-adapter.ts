/**
 * Build-terminal verify gate for app_build ops — wraps the real build adapter
 * (either strategy) and gates a clean completion. Layers, all enforced on
 * every model and strategy at this one chokepoint (teaching alone is a request
 * a strong-priored model can override):
 *
 *   1. Static scans (app-build-verify.ts): faked frontend, startup errors,
 *      raw cross-origin fetch, unverified native parity. Static builds only —
 *      a framework scaffold has no flat HTML entry to scan.
 *   2. Headless smoke (see-before-done): actually LOAD the built app and
 *      observe it. Static builds load file://index.html in "strict" mode
 *      (any console error fails); framework/full-stack builds load their
 *      LIVE dev-server proxy URL in "hard-signals" mode (uncaught errors /
 *      mount fail; dev-server console chatter rides to the judge instead).
 *      Render evidence lands in .lax-build/smoke.png.
 *   3. Interact-then-re-smoke: a clean load clicks the page's primary action
 *      (semantic button role) and re-runs the checks — the maze-escape-3d
 *      class hid its breakage BEHIND the Start button, so the start screen
 *      alone proved nothing. Post-click evidence: .lax-build/smoke-2.png.
 *   4. Vision judge: the screenshots + the build brief go to the screenshot
 *      judge (vision-verify.ts — the render probe's judge, background model on
 *      the existing Anthropic credential, no new key). One question: does this
 *      look like what was asked, or garbage? A rejection fails the build with
 *      the judge's reason. No verdict available (no vision-capable credential
 *      — CLI OAuth can't carry image bytes) → the check skips, never fails.
 *
 * A smoke that can't run (missing chromium binary) SKIPS with a warning — an
 * environment problem is never a build verdict. A dev server that never
 * becomes ready FAILS — a live server is the framework tiers' whole promise.
 *
 * Every gate failure also emits a canonical USER message carrying the failure
 * text AND the screenshot(s) as image refs (VERIFY_EVIDENCE_MARKER). That row
 * is durable in op_messages; build-session-context reads it on the next
 * update build so the fixer gets the pixels, not just prose.
 *
 * Runner + judge + URL resolver live in app-build-smoke-gate.ts (400-LOC cap).
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import {
  scanAppForBlockedFetch, formatBlockedFetchError,
  scanAppForStartupErrors, formatStartupErrors,
  scanAppForUnverifiedNativeParity, formatUnverifiedNativeParity,
  scanAppForFakedFrontend, formatFakedFrontend,
  scanAppForFrameworkHybrid, formatFrameworkHybrid,
} from "../../tools/app-build-verify.js";
import type { AppTier } from "../../tools/app-tier.js";
import { detectFramework } from "../../tools/framework-detect.js";
import { getDesignSpec } from "../turn-loop/design-verify.js";
import { finalizeFrameworkBuild, type FinalizeFrameworkDeps } from "./app-build-finalize.js";
import {
  runAppSmokeGate,
  runAppVisionJudge,
  resolveDevServerProxyUrl,
  type AppSmokeGateRunner,
  type AppSmokeGateSpec,
  type AppVisionJudge,
  type DevServerUrlResolver,
} from "./app-build-smoke-gate.js";

export {
  runAppSmokeGate,
  runAppVisionJudge,
  resolveDevServerProxyUrl,
  type AppSmokeGateRunner,
  type AppSmokeGateSpec,
  type AppSmokeGateOutcome,
  type AppVisionJudge,
  type DevServerUrlResolver,
} from "./app-build-smoke-gate.js";

/** First line of the evidence user-message a failed gate appends to
 *  op_messages. build-session-context keys off it to thread the failure —
 *  text and screenshots — into the next update build's context. */
export const VERIFY_EVIDENCE_MARKER = "=== BUILD VERIFY EVIDENCE ===";

export interface AppBuildVerifyOptions {
  /** The user's raw build brief — what the vision judge compares the render
   *  against. Absent → the judge is skipped (it can't answer "does this look
   *  like what was asked" without the ask). */
  brief?: string;
  /** Test seam: override the vision judge so unit tests never dispatch. */
  judge?: AppVisionJudge;
  /** Test seam: override the dev-server URL lookup so unit tests never read
   *  real dev-server records. */
  urlResolver?: DevServerUrlResolver;
  /** Test seam: framework-finalize deps (registerDevServer etc.) forwarded to
   *  finalizeFrameworkBuild when the smoke gate must register a dev server the
   *  in-canonical path never did. Production passes nothing (defaults resolve
   *  to the real dev-server module). */
  finalizeDeps?: FinalizeFrameworkDeps;
}

export class AppBuildVerifyAdapter implements Adapter {
  private readonly judge: AppVisionJudge;
  private readonly brief: string;
  private readonly urlResolver: DevServerUrlResolver;
  private readonly finalizeDeps: FinalizeFrameworkDeps;
  constructor(
    private readonly inner: Adapter,
    private readonly appDir: string,
    private readonly tier?: AppTier,
    private readonly smokeGate: AppSmokeGateRunner = runAppSmokeGate,
    opts: AppBuildVerifyOptions = {},
  ) {
    this.judge = opts.judge ?? runAppVisionJudge;
    this.brief = opts.brief ?? "";
    this.urlResolver = opts.urlResolver ?? resolveDevServerProxyUrl;
    this.finalizeDeps = opts.finalizeDeps ?? {};
  }
  get name(): string { return this.inner.name; }
  get version(): string { return this.inner.version; }

  /**
   * Durable failure evidence: a canonical user row with the gate's verdict
   * text AND the screenshot(s) as image refs. Rides message_finalized so
   * commitTurn persists it even on this error terminal; the images carry
   * filePath (bytes are read at request time by the transports), so the row
   * stays small on disk. The next update build's context seeding
   * (build-session-context) picks it up by VERIFY_EVIDENCE_MARKER and hands
   * the fixer the pixels, not just prose.
   */
  private emitFailureEvidence(
    input: TurnInput,
    report: (r: AdapterReport) => void,
    detail: string,
    screenshotPaths: Array<string | undefined>,
  ): void {
    const images = screenshotPaths
      .filter((p): p is string => typeof p === "string" && existsSync(p))
      .map((p) => ({ url: "", name: basename(p), filePath: p }));
    report({
      kind: "message_finalized",
      message: {
        messageId: `um-${input.opId}-${input.turnIdx}-verify-evidence`,
        role: "user",
        content: {
          text: `${VERIFY_EVIDENCE_MARKER}\n${detail}`,
          ...(images.length > 0 ? { images } : {}),
        },
      },
    });
  }

  async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
    const result = await this.inner.runTurn(input, report);
    if (result.terminalReason !== "done") return result;
    // A two-framework hybrid (Next + a serving vite.config, or vice-versa) ships
    // one dead config and a blank page — detectFramework serves ONE, the other's
    // base/HMR config is inert. Reject before smoking, whichever tier this is:
    // the scan is cheap and inert on any app without a "next" signal.
    const hybrid = scanAppForFrameworkHybrid(this.appDir);
    if (hybrid.hybrid) {
      report({ kind: "error", code: "framework_hybrid", message: formatFrameworkHybrid(hybrid.reason), retryable: false });
      return { ...result, terminalReason: "error" };
    }
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
      // Real project present — the static-HTML scans below would misread it
      // (a Vite index.html legitimately points at /src/main.jsx). Smoke the
      // LIVE dev server instead of a flat file.
      return this.smokeAndJudge(input, report, result, "hard-signals");
    }
    // On-disk truth supersedes the prompt-classified tier: a real framework
    // scaffold (Next/Vite/…) has no static HTML entry, so the scans below
    // would falsely reject it — same reasoning as the frontend-spa branch.
    const detected = detectFramework(this.appDir).framework;
    if (detected !== "static" && detected !== "unknown") {
      return this.smokeAndJudge(input, report, result, "hard-signals");
    }
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
    return this.smokeAndJudge(input, report, result, "strict");
  }

  /** Layers 2–4 for one build: smoke (static file:// strict, or live
   *  dev-server hard-signals), then the vision judge over the evidence. */
  private async smokeAndJudge(
    input: TurnInput,
    report: (r: AdapterReport) => void,
    result: TurnResult,
    mode: AppSmokeGateSpec["mode"],
  ): Promise<TurnResult> {
    let url: string | undefined;
    if (mode === "hard-signals") {
      const appName = basename(this.appDir);
      let resolved = await this.urlResolver(appName);
      if (!resolved) {
        // No dev-server record. The cli-subprocess path registers one in
        // finalizeFrameworkBuild, but the in-canonical path never does unless
        // the model itself called app_serve_frontend — and a model that never
        // served is exactly the empty-node_modules / black-page failure. So
        // register the detected framework's dev server NOW and smoke it for
        // real, instead of skipping the one gate that catches a blank page.
        resolved = await this.registerFrameworkServer(appName, report);
      }
      if (!resolved) {
        // Still no servable dev server: a framework build with nothing to serve
        // at /apps/<id>/ renders blank. That's a build failure, not a skip —
        // the tier's whole promise is a live server (see file header).
        const detail =
          `This build reported ready but has no servable dev server for "${appName}" — no framework project ` +
          `was scaffolded that LAX can serve at /apps/${appName}/, so the app renders a blank page. Scaffold a ` +
          `REAL project (package.json + the framework config + src/) and start it with app_serve_frontend, or ` +
          `if this is a static app, ship a plain index.html instead.`;
        report({ kind: "error", code: "app_smoke_failed", message: detail, retryable: false });
        return { ...result, terminalReason: "error" };
      }
      url = resolved;
    }
    const smoke = await this.smokeGate({ appDir: this.appDir, url, mode });
    const shots = [smoke.screenshotPath, smoke.interactionScreenshotPath];
    if (smoke.verdict === "fail") {
      const detail = smoke.detail ?? "smoke failed";
      this.emitFailureEvidence(input, report, detail, shots);
      report({ kind: "error", code: "app_smoke_failed", message: detail, retryable: false });
      return { ...result, terminalReason: "error" };
    }
    if (smoke.verdict === "skipped") {
      report({ kind: "stream_chunk", body: { delta: `[verify] smoke gate skipped: ${smoke.detail}\n` } });
      return result;
    }
    report({ kind: "stream_chunk", body: { delta: `[verify] smoke passed — ${url ?? "page"} loaded, mounted, no ${mode === "strict" ? "console" : "uncaught"} errors${smoke.interactionScreenshotPath ? ", survived its primary action" : ""}${smoke.screenshotPath ? ` (evidence: ${smoke.screenshotPath})` : ""}\n` } });
    // Behavior is clean — last question is appearance: does the render look
    // like what was ASKED? Deterministic checks can't see wrong-but-quiet
    // rendering (the black-screen maze that throws nothing).
    const judgeShots = shots.filter((p): p is string => typeof p === "string");
    if (this.brief && judgeShots.length > 0) {
      const judgeBrief = smoke.judgeNotes ? `${this.brief}\n\n(${smoke.judgeNotes})` : this.brief;
      const verdict = await this.judge(judgeShots, judgeBrief, getDesignSpec(input.opId));
      if (verdict === null) {
        report({ kind: "stream_chunk", body: { delta: `[verify] vision judge unavailable (no vision-capable credential) — skipped\n` } });
      } else if (!verdict.ok) {
        const detail =
          `The app renders without errors, but a vision check compared the screenshots against the brief and REJECTED the ` +
          `build: ${verdict.reason || "does not look like what was asked"}. ` +
          `Screenshots: ${judgeShots.join(", ")} — read/view them before claiming a fix.`;
        this.emitFailureEvidence(input, report, detail, shots);
        report({ kind: "error", code: "app_vision_rejected", message: detail, retryable: false });
        return { ...result, terminalReason: "error" };
      } else {
        report({ kind: "stream_chunk", body: { delta: `[verify] vision judge passed — render matches the brief\n` } });
      }
    }
    return result;
  }

  /** Register the detected framework's dev server (the in-canonical path never
   *  does — only CliBuildAdapter calls finalizeFrameworkBuild) so the live smoke
   *  has a URL to load. Returns the proxy URL, or undefined when there's nothing
   *  to serve (static/unknown → {handled:false}) or registration failed. */
  private async registerFrameworkServer(
    appName: string, report: (r: AdapterReport) => void,
  ): Promise<string | null> {
    const finalized = await finalizeFrameworkBuild(
      {
        appDir: this.appDir,
        appName,
        laxPort: process.env.LAX_PORT ?? "7007",
        registerServer: true,
      },
      this.finalizeDeps,
    );
    if (!finalized.handled) return null;  // static/unknown — no framework to serve
    if (!finalized.ok) {
      report({ kind: "stream_chunk", body: { delta: `[verify] dev-server registration failed: ${finalized.message}\n` } });
      return null;
    }
    return finalized.url;
  }

  abort(reason?: unknown): Promise<void> { return this.inner.abort(reason); }
}

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
 *   3. Interact-then-re-smoke: a clean initial load clicks the page's primary
 *      action (semantic button role) and re-runs the console/mount checks —
 *      the maze-escape-3d class hid its breakage BEHIND the Start button, so
 *      the start screen alone proved nothing. Post-click evidence lands in
 *      .lax-build/smoke-2.png.
 *   4. Vision judge: both screenshots + the build brief go to the screenshot
 *      judge (vision-verify.ts — the render probe's judge, background model on
 *      the existing Anthropic credential, no new key). One question: does this
 *      look like what was asked, or garbage? A rejection fails the build with
 *      the judge's reason. No verdict available (no vision-capable credential
 *      — CLI OAuth can't carry image bytes) → the check skips, never fails.
 *
 * A smoke that can't run (missing chromium binary on this machine) SKIPS with
 * a warning — an environment problem is never a build verdict.
 *
 * Every gate failure also emits a canonical USER message carrying the failure
 * text AND the screenshot(s) as image refs (VERIFY_EVIDENCE_MARKER). That row
 * is durable in op_messages; build-session-context reads it on the next
 * update build so the fixer gets the pixels, not just prose.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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

/** First line of the evidence user-message a failed gate appends to
 *  op_messages. build-session-context keys off it to thread the failure —
 *  text and screenshots — into the next update build's context. */
export const VERIFY_EVIDENCE_MARKER = "=== BUILD VERIFY EVIDENCE ===";

export interface AppSmokeGateOutcome {
  verdict: "pass" | "fail" | "skipped";
  /** fail → actionable error for the fixer; skipped → why the gate couldn't run. */
  detail?: string;
  /** Render-evidence PNG of the initial load, when captured. */
  screenshotPath?: string;
  /** Render-evidence PNG taken after clicking the primary action, when captured. */
  interactionScreenshotPath?: string;
}

/** Injectable so adapter tests don't launch a real browser. */
export type AppSmokeGateRunner = (appDir: string) => Promise<AppSmokeGateOutcome>;

/** Injectable vision judge: screenshot PNG paths + the build brief → verdict,
 *  or null when no verdict could be obtained (treated as "skip the check"). */
export type AppVisionJudge = (
  screenshotPaths: string[],
  brief: string,
) => Promise<{ ok: boolean; reason: string } | null>;

/**
 * Default judge: read the evidence PNGs and ask the shared screenshot judge
 * (the same one the render-verify probe uses) whether the render matches the
 * brief. Lazy import keeps the dispatch/provider graph out of this adapter's
 * static imports. Never throws; unreadable shots or no credential → null.
 */
export const runAppVisionJudge: AppVisionJudge = async (screenshotPaths, brief) => {
  const shots: string[] = [];
  for (const p of screenshotPaths) {
    try { shots.push(readFileSync(p).toString("base64")); } catch { /* missing shot — judge what we have */ }
  }
  if (shots.length === 0) return null;
  const { visionVerdictForScreenshot } = await import("../../tools/app-tools/vision-verify.js");
  const verdict = await visionVerdictForScreenshot(shots, brief);
  return verdict ? { ok: verdict.ok, reason: verdict.reason } : null;
};

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
  const interactionScreenshotPath = join(appDir, ".lax-build", "smoke-2.png");
  let smoke;
  try {
    smoke = await smokeUrl(fileUrl, SMOKE_LOAD_TIMEOUT_MS, undefined, {
      screenshotPath,
      interact: { screenshotPath: interactionScreenshotPath },
    });
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
  // Phase 2: the initial screen was clean — walk through it. The maze-escape-3d
  // class passed everything above because its breakage lived behind Start.
  const i = smoke.interaction;
  if (i?.clicked) {
    const evidence2 = i.screenshotPath
      ? ` Screenshots: before the click at ${smoke.screenshotPath}, after it at ${i.screenshotPath} — read/view them before claiming a fix.`
      : evidence;
    if (i.consoleErrors.length > 0) {
      return {
        verdict: "fail", screenshotPath: smoke.screenshotPath, interactionScreenshotPath: i.screenshotPath,
        detail:
          `The built page loads clean, but clicking its primary action threw ${i.consoleErrors.length} console error(s) — ` +
          `it breaks the moment the user interacts. First: "${i.consoleErrors[0]}".${evidence2}`,
      };
    }
    if (!i.rootMounted) {
      return {
        verdict: "fail", screenshotPath: smoke.screenshotPath, interactionScreenshotPath: i.screenshotPath,
        detail:
          `The built page loads clean, but clicking its primary action left the page EMPTY — no canvas painted and no mount ` +
          `root has content after the interaction.${evidence2}`,
      };
    }
  }
  return { verdict: "pass", screenshotPath: smoke.screenshotPath, interactionScreenshotPath: i?.screenshotPath };
};

export interface AppBuildVerifyOptions {
  /** The user's raw build brief — what the vision judge compares the render
   *  against. Absent → the judge is skipped (it can't answer "does this look
   *  like what was asked" without the ask). */
  brief?: string;
  /** Test seam: override the vision judge so unit tests never dispatch. */
  judge?: AppVisionJudge;
}

export class AppBuildVerifyAdapter implements Adapter {
  private readonly judge: AppVisionJudge;
  private readonly brief: string;
  constructor(
    private readonly inner: Adapter,
    private readonly appDir: string,
    private readonly tier?: AppTier,
    private readonly smokeGate: AppSmokeGateRunner = runAppSmokeGate,
    opts: AppBuildVerifyOptions = {},
  ) {
    this.judge = opts.judge ?? runAppVisionJudge;
    this.brief = opts.brief ?? "";
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
    report({ kind: "stream_chunk", body: { delta: `[verify] smoke passed — page loaded, mounted, 0 console errors${smoke.interactionScreenshotPath ? ", survived its primary action" : ""}${smoke.screenshotPath ? ` (evidence: ${smoke.screenshotPath})` : ""}\n` } });
    // Behavior is clean — last question is appearance: does the render look
    // like what was ASKED? Deterministic checks can't see wrong-but-quiet
    // rendering (the black-screen maze that throws nothing).
    const judgeShots = shots.filter((p): p is string => typeof p === "string");
    if (this.brief && judgeShots.length > 0) {
      const verdict = await this.judge(judgeShots, this.brief);
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

  abort(reason?: unknown): Promise<void> { return this.inner.abort(reason); }
}

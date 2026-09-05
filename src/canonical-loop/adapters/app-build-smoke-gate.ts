/**
 * Smoke-gate runner + vision judge for the app_build verify terminal
 * (AppBuildVerifyAdapter wires these; split out for the 400-LOC cap).
 *
 * Two smoke targets, one evaluator:
 *   - static builds smoke a LOCAL HTTP ORIGIN serving the build at the same
 *     `/apps/<id>/` mount, under the same response policy and the same
 *     request→file resolution the LAX server uses (app-build-smoke-origin.ts)
 *     in "strict" mode — any console error fails, exactly the original
 *     see-before-done contract. Chromium logs a CSP refusal and a 404 asset as
 *     console errors, so both land in that net. This used to be
 *     `file://index.html`, where there is neither a CSP nor a route shape: a
 *     cross-origin fetch the served app can never make succeeded, and a
 *     root-absolute `/main.js` resolved off the filesystem root, so the gate
 *     observed a page the user would never get.
 *   - framework/full-stack builds smoke their LIVE dev-server proxy URL
 *     (`/apps/<name>/` — the same URL the user's Open button hits, which
 *     lazily boots the server) in "hard-signals" mode: uncaught pageerrors,
 *     a dead mount, or a broken interaction fail; ordinary console errors do
 *     NOT — dev servers chat (HMR reconnects, dev-mode warnings), and a gate
 *     that kills healthy builds is worse than one that misses quiet breaks.
 *     Those console errors ride to the vision judge as notes instead.
 *
 * A dev server that never becomes ready is a FAIL, not a skip — the tier's
 * whole promise is a live server.
 *
 * A browser that never opens is still a SKIP (a decided product call) and a
 * skip still ships the build unverified — but it is no longer silent: the
 * outcome carries a `skipKind` and a detail naming the condition, the real
 * launch error and the fix, which the verify adapter turns into a durable,
 * after-the-fact user-visible note. Whether a box with no browser may build
 * apps at all is still not a question this file gets to answer.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { smokeUrl, type SmokeResult } from "../../auto-build/scenario-scorer/smoke.js";
import { BROWSER_INSTALL_FIX, probeBrowserAvailability } from "../../browser-availability.js";
import { startStaticSmokeOrigin, staticSmokeServeRoot, type SmokeOrigin } from "./app-build-smoke-origin.js";

const SMOKE_LOAD_TIMEOUT_MS = 30_000;
/** Generous because the proxy's first hit lazily COLD-STARTS the dev server —
 *  matches dev-server.ts's own lazy-restart bind budget. */
const DEV_SERVER_READY_TIMEOUT_MS = 60_000;
const DEV_SERVER_POLL_MS = 1_000;

export interface AppSmokeGateSpec {
  appDir: string;
  /** Live URL to smoke (framework/full-stack builds). Absent → the app is
   *  served from a throwaway local origin under the real workspace-app policy. */
  url?: string;
  /** strict: console errors fail (static builds). hard-signals: only
   *  pageerrors / mount / interaction fail; console errors go to the judge. */
  mode: "strict" | "hard-signals";
}

export interface AppSmokeGateOutcome {
  verdict: "pass" | "fail" | "skipped";
  /** fail → actionable error for the fixer; skipped → why the gate couldn't run. */
  detail?: string;
  /** skipped only: WHY the gate could not run, machine-readably. Both values
   *  mean THE BROWSER NEVER OPENED, so the smoke AND the vision judge that
   *  reads its screenshots both no-opped — which is what earns the durable
   *  user-visible note. They differ in what to do about it:
   *   - "no-browser": there was nothing to launch. browser-availability.ts is
   *     the authority, and the remedy is its install command.
   *   - "browser-launch-failed": Playwright says its chromium IS on disk and
   *     the launch threw anyway — a truncated/partial `playwright install`, a
   *     missing shared library, a sandbox. The remedy is a REINSTALL, and the
   *     real launch error (not a guessed cause) is in `detail`. Before this
   *     existed, a corrupt binary probed as "available" and fell through to an
   *     unclassified, un-noted skip: silently unverified, exactly the outcome
   *     this classification exists to end.
   *  Absent = a skip for some future reason that is NOT about the browser;
   *  `detail` is then the only account of it. */
  skipKind?: "no-browser" | "browser-launch-failed";
  /** fail only: what the verdict is ABOUT. Default "app" — the build is broken.
   *  "environment" — the gate itself could not run on THIS machine (e.g. no
   *  loopback port to bind), so the build is unverified and the app is not the
   *  thing to change. The prose detail says so; this is the same statement on
   *  the machine-readable channel, so a caller need not parse English. */
  failureKind?: "app" | "environment";
  /** Render-evidence PNG of the initial load, when captured. */
  screenshotPath?: string;
  /** Render-evidence PNG taken after clicking the primary action, when captured. */
  interactionScreenshotPath?: string;
  /** Hard-signals mode only: console errors that did NOT fail the gate,
   *  surfaced to the vision judge as context. */
  judgeNotes?: string;
}

/** Injectable so adapter tests don't launch a real browser. */
export type AppSmokeGateRunner = (spec: AppSmokeGateSpec) => Promise<AppSmokeGateOutcome>;

/** Injectable vision judge: screenshot PNG paths + the build brief → verdict,
 *  or null when no verdict could be obtained (treated as "skip the check"). */
export type AppVisionJudge = (
  screenshotPaths: string[],
  brief: string,
  designSpec?: string,
) => Promise<{ ok: boolean; reason: string } | null>;

/** Injectable dev-server URL lookup: app name → the live proxy URL to smoke,
 *  or null when no dev-server record exists (gate skips — the tier gates own
 *  server liveness, the smoke gate won't invent a verdict about it). */
export type DevServerUrlResolver = (appName: string) => Promise<string | null>;

/** Default resolver: the app's dev-server record → the LAX reverse-proxy URL
 *  (`/apps/<name>/`). The proxy is deliberate: it's what the user's Open hits,
 *  it lazily starts the server, and it injects the dev connector token the
 *  frontend needs. Dynamic import keeps process machinery out of unit tests. */
export const resolveDevServerProxyUrl: DevServerUrlResolver = async (appName) => {
  const { readDevServerRecord } = await import("../../tools/dev-server.js");
  const { staticBuildDistDir } = await import("../../tools/app-run-target.js");
  const { workspacePath } = await import("../../config.js");
  // A finished static-build app has NO dev-server record but is still served at
  // /apps/<name>/ (from its built dist/) — so the smoke has a live URL to load.
  // Without this the resolver would return null and the caller would needlessly
  // spin up a dev server for an app that already serves statically.
  const hasStatic = staticBuildDistDir(workspacePath("apps", appName)) !== null;
  if (!readDevServerRecord(appName) && !hasStatic) return null;
  const laxPort = process.env.LAX_PORT ?? "7007";
  return `http://127.0.0.1:${laxPort}/apps/${appName}/`;
};

/**
 * Default judge: read the evidence PNGs and ask the shared screenshot judge
 * (the same one the render-verify probe uses) whether the render matches the
 * brief. Lazy import keeps the dispatch/provider graph out of this module's
 * static imports. Never throws; unreadable shots or no credential → null.
 */
export const runAppVisionJudge: AppVisionJudge = async (screenshotPaths, brief, designSpec) => {
  const shots: string[] = [];
  for (const p of screenshotPaths) {
    try { shots.push(readFileSync(p).toString("base64")); } catch { /* missing shot — judge what we have */ }
  }
  if (shots.length === 0) return null;
  const { visionVerdictForScreenshot } = await import("../../tools/app-tools/vision-verify.js");
  const verdict = await visionVerdictForScreenshot(shots, brief, {}, designSpec);
  return verdict ? { ok: verdict.ok, reason: verdict.reason } : null;
};

/**
 * Poll the dev-server URL until it answers below 500. The proxy holds a 503
 * "starting…" page (HTML) / 502 (other) while the server cold-boots, so the
 * status line alone separates "still booting" from "up" — never judge the
 * holding page. Draining the body keeps undici's socket pool clean.
 */
async function waitForDevServer(url: string): Promise<{ ready: boolean; last: string }> {
  const deadline = Date.now() + DEV_SERVER_READY_TIMEOUT_MS;
  let last = "no response";
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      await res.text().catch(() => "");
      if (res.status < 500) return { ready: true, last: `HTTP ${res.status}` };
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message.slice(0, 120);
    }
    if (Date.now() >= deadline) return { ready: false, last };
    await new Promise((r) => setTimeout(r, DEV_SERVER_POLL_MS));
  }
}

/**
 * Load the built app headlessly and judge what happened. Static builds get a
 * throwaway local origin serving them under the real workspace-app policy; the
 * live proxy URL is used for framework builds (which the LAX server already
 * serves under that policy itself).
 */
export const runAppSmokeGate: AppSmokeGateRunner = async (spec) => {
  const { appDir, mode } = spec;
  let target: string;
  let origin: SmokeOrigin | undefined;
  if (spec.url) {
    const ready = await waitForDevServer(spec.url);
    if (!ready.ready) {
      return {
        verdict: "fail",
        detail:
          `The app's dev server never became ready at ${spec.url} within ${DEV_SERVER_READY_TIMEOUT_MS / 1000}s ` +
          `(last: ${ready.last}). It was reported APP_READY but cannot be opened — the server crashes or never binds. ` +
          `Check ~/.lax/logs/dev-servers/${basename(appDir)}.log for the server's own output.`,
      };
    }
    target = spec.url;
  } else {
    // Ask about the file the browser will load: a finished static build serves
    // its dist/, so a source-tree index.html is not the page under test.
    const entry = resolve(staticSmokeServeRoot(appDir), "index.html");
    if (!existsSync(entry)) {
      return {
        verdict: "fail",
        detail:
          `The build has no index.html at ${entry}, so there is nothing to open. It was reported APP_READY but ` +
          `ships no page.`,
      };
    }
    try {
      origin = await startStaticSmokeOrigin(appDir);
    } catch (e) {
      // Port exhaustion, a firewall blocking loopback, EMFILE. NOT a statement
      // about the build — but it must not be silently indistinguishable from a
      // clean smoke either, because "skipped" ships the build unverified. Fail
      // loudly and say plainly that this is the machine, not the code.
      return {
        verdict: "fail",
        failureKind: "environment",
        detail:
          `The smoke gate could not start its local origin, so this build was NOT verified: ` +
          `${(e as Error).message.slice(0, 200)}. This is an environment failure on the build machine ` +
          `(no free loopback port, a firewall blocking 127.0.0.1, or too many open files) — not a defect in the app. ` +
          `Fix the machine and re-run; do not "fix" the app for this.`,
      };
    }
    target = origin.url;
  }
  const screenshotPath = join(appDir, ".lax-build", "smoke.png");
  const interactionScreenshotPath = join(appDir, ".lax-build", "smoke-2.png");
  let smoke;
  try {
    smoke = await smokeUrl(target, SMOKE_LOAD_TIMEOUT_MS, undefined, {
      screenshotPath,
      interact: { screenshotPath: interactionScreenshotPath },
    });
  } catch (e) {
    // Anything thrown out of smokeUrl came from openPageWithConsoleCapture:
    // everything after the launch is caught in there and surfaces as
    // `loadError`, not a throw. So reaching here means THE BROWSER NEVER
    // OPENED — nothing looked at the app — whatever the probe goes on to say.
    //
    // The launch error is carried in BOTH branches, never replaced by the
    // probe's verdict. Reporting only the verdict meant every launch failure
    // was retold as "no headless browser" with an install remedy that could be
    // the wrong advice, and it destroyed the one piece of evidence that
    // distinguishes a corrupt binary (probe says available, launch throws
    // anyway) from a machine that genuinely has no browser.
    //
    // Probing here rather than before the launch keeps the happy path free of
    // it and classifies the failure that actually happened rather than a
    // prediction of it.
    const launchError = (e as Error).message.slice(0, 200);
    const browser = probeBrowserAvailability();
    if (browser.available) {
      return {
        verdict: "skipped",
        skipKind: "browser-launch-failed",
        detail:
          `the headless browser would not launch on this machine even though Playwright reports its chromium ` +
          `binary is present — the launch failed with: ${launchError}. An interrupted or partial browser install ` +
          `is the usual cause; re-run: ${BROWSER_INSTALL_FIX}`,
      };
    }
    return {
      verdict: "skipped",
      skipKind: "no-browser",
      detail:
        `no headless browser on this machine — ${browser.message}. The launch failed with: ${launchError}. ` +
        `Fix: ${BROWSER_INSTALL_FIX}`,
    };
  } finally {
    await origin?.close();
  }
  return evaluateSmoke(smoke, mode);
};

function evaluateSmoke(smoke: SmokeResult, mode: AppSmokeGateSpec["mode"]): AppSmokeGateOutcome {
  const evidence = smoke.screenshotPath
    ? ` A screenshot of what the app actually rendered is saved at ${smoke.screenshotPath} — read/view it before claiming a fix.`
    : "";
  const fail = (detail: string): AppSmokeGateOutcome => ({
    verdict: "fail",
    screenshotPath: smoke.screenshotPath,
    interactionScreenshotPath: smoke.interaction?.screenshotPath,
    detail,
  });
  if (smoke.loadError) {
    return fail(`The built page failed to load headlessly (${smoke.loadError}). It was reported APP_READY but does not open.${evidence}`);
  }
  // Strict (static build on its own origin): every console error fails — the
  // page has no dev server to blame noise on. Hard-signals (live dev server):
  // only UNCAUGHT errors fail; console chatter goes to the judge instead.
  const hardErrors = mode === "strict" ? smoke.consoleErrors : smoke.pageErrors;
  const errorNoun = mode === "strict" ? "console" : "uncaught";
  if (hardErrors.length > 0) {
    return fail(
      `The built page throws ${hardErrors.length} ${errorNoun} error(s) on load — it was reported APP_READY but is broken at runtime. ` +
      `First: "${hardErrors[0]}".${evidence}`,
    );
  }
  if (!smoke.rootMounted) {
    return fail(
      `The built page loads with no ${errorNoun} errors but renders NOTHING — no canvas painted and no mount root has content. ` +
      `It was reported APP_READY but shows an empty page.${evidence}`,
    );
  }
  const i = smoke.interaction;
  if (i?.clicked) {
    const evidence2 = i.screenshotPath
      ? ` Screenshots: before the click at ${smoke.screenshotPath}, after it at ${i.screenshotPath} — read/view them before claiming a fix.`
      : evidence;
    const hardClickErrors = mode === "strict" ? i.consoleErrors : i.pageErrors;
    if (hardClickErrors.length > 0) {
      return fail(
        `The built page loads clean, but clicking its primary action threw ${hardClickErrors.length} ${errorNoun} error(s) — ` +
        `it breaks the moment the user interacts. First: "${hardClickErrors[0]}".${evidence2}`,
      );
    }
    if (!i.rootMounted) {
      return fail(
        `The built page loads clean, but clicking its primary action left the page EMPTY — no canvas painted and no mount ` +
        `root has content after the interaction.${evidence2}`,
      );
    }
  }
  const outcome: AppSmokeGateOutcome = {
    verdict: "pass",
    screenshotPath: smoke.screenshotPath,
    interactionScreenshotPath: i?.screenshotPath,
  };
  if (mode === "hard-signals") {
    const chatter = [...smoke.consoleErrors, ...(i?.consoleErrors ?? [])]
      .filter((e) => !e.startsWith("pageerror: "));
    if (chatter.length > 0) {
      outcome.judgeNotes =
        `The page logged ${chatter.length} console error(s) that did not fail the deterministic gate ` +
        `(dev servers are noisy): ${chatter.slice(0, 3).map((c) => `"${c}"`).join(", ")}`;
    }
  }
  return outcome;
}

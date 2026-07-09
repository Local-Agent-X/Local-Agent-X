/**
 * Smoke-gate runner + vision judge for the app_build verify terminal
 * (AppBuildVerifyAdapter wires these; split out for the 400-LOC cap).
 *
 * Two smoke targets, one evaluator:
 *   - static builds smoke `file://index.html` in "strict" mode — any console
 *     error fails, exactly the original see-before-done contract.
 *   - framework/full-stack builds smoke their LIVE dev-server proxy URL
 *     (`/apps/<name>/` — the same URL the user's Open button hits, which
 *     lazily boots the server) in "hard-signals" mode: uncaught pageerrors,
 *     a dead mount, or a broken interaction fail; ordinary console errors do
 *     NOT — dev servers chat (HMR reconnects, dev-mode warnings), and a gate
 *     that kills healthy builds is worse than one that misses quiet breaks.
 *     Those console errors ride to the vision judge as notes instead.
 *
 * A dev server that never becomes ready is a FAIL, not a skip — the tier's
 * whole promise is a live server. Missing chromium stays a skip: an
 * environment problem is never a build verdict.
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { smokeUrl, type SmokeResult } from "../../auto-build/scenario-scorer/smoke.js";

const SMOKE_LOAD_TIMEOUT_MS = 30_000;
/** Generous because the proxy's first hit lazily COLD-STARTS the dev server —
 *  matches dev-server.ts's own lazy-restart bind budget. */
const DEV_SERVER_READY_TIMEOUT_MS = 60_000;
const DEV_SERVER_POLL_MS = 1_000;

export interface AppSmokeGateSpec {
  appDir: string;
  /** Live URL to smoke (framework/full-stack builds). Absent → file://index.html. */
  url?: string;
  /** strict: console errors fail (static builds). hard-signals: only
   *  pageerrors / mount / interaction fail; console errors go to the judge. */
  mode: "strict" | "hard-signals";
}

export interface AppSmokeGateOutcome {
  verdict: "pass" | "fail" | "skipped";
  /** fail → actionable error for the fixer; skipped → why the gate couldn't run. */
  detail?: string;
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
 * Load the built app headlessly and judge what happened. file:// like the
 * chunk-review build-exec gate for static builds; the live proxy URL for
 * framework builds (smokeUrl handles both schemes).
 */
export const runAppSmokeGate: AppSmokeGateRunner = async (spec) => {
  const { appDir, mode } = spec;
  let target: string;
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
    target = "file://" + resolve(appDir, "index.html").replace(/\\/g, "/");
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
    return { verdict: "skipped", detail: `headless smoke unavailable: ${(e as Error).message.slice(0, 200)}` };
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
  // Strict (static file://): every console error fails — the page has no dev
  // server to blame noise on. Hard-signals (live dev server): only UNCAUGHT
  // errors fail; console chatter goes to the judge instead.
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

/**
 * The checks a built app passes before it is called done, and what they found.
 *
 * One function, two callers: the app_build op's terminal gate
 * (app-build-verify-adapter.ts, whose header describes each layer and why it
 * blocks) and the chat's own check of an app it wrote (tools/app-check-tool.ts).
 * It decides; the caller reports. So an app the chat built is held to exactly
 * what a worker's build is.
 */
import { basename } from "node:path";
import {
  scanAppForBlockedFetch, formatBlockedFetchError,
  scanAppForStartupErrors, formatStartupErrors,
  scanAppForUnverifiedNativeParity, formatUnverifiedNativeParity,
  scanAppForFakedFrontend, formatFakedFrontend,
  scanAppForFrameworkHybrid, formatFrameworkHybrid,
} from "../../tools/app-build-verify.js";
import type { AppTier } from "../../tools/app-tier.js";
import { detectFramework } from "../../tools/framework-detect.js";
import { finalizeFrameworkBuild, type FinalizeFrameworkDeps } from "./app-build-finalize.js";
import { runAppStructureGate, type StructureGateRunner } from "./app-build-structure-gate.js";
import {
  runAppSmokeGate, runAppVisionJudge, resolveDevServerProxyUrl, resolveBackendAppUrl,
  type AppSmokeGateRunner, type AppSmokeGateSpec, type AppVisionJudge, type DevServerUrlResolver,
} from "./app-build-smoke-gate.js";
import { selfPort } from "../../security/layer/loopback-grant.js";

/** The gates, each replaceable so a test never launches a browser or a model. */
export interface AppVerifyGates {
  smokeGate?: AppSmokeGateRunner;
  judge?: AppVisionJudge;
  urlResolver?: DevServerUrlResolver;
  /** A static page's registered-backend URL (resolveBackendAppUrl). */
  backendUrlResolver?: DevServerUrlResolver;
  /** Framework-finalize deps, for registering a dev server nobody started. */
  finalizeDeps?: FinalizeFrameworkDeps;
  structureGate?: StructureGateRunner;
}

export interface AppVerifyInput {
  appDir: string;
  tier?: AppTier;
  /** What was asked for: what the vision judge compares the render against.
   *  "" skips the judge (it cannot answer "does this look like what was asked"). */
  brief: string;
  /** The app is being created, not updated: a project-shaped tier that
   *  scaffolded its own project adopts the structure kit here. */
  newBuild: boolean;
  /** The op the checks run under (the structure check is a harness command). */
  opId: string;
  /** The design spec the build was given, for the judge. */
  designSpec?: string;
  /** The session the app's requests are judged against (taint, canary). */
  sessionId?: string;
  gates?: AppVerifyGates;
  /** A progress line ("[verify] ..."), as it happens. */
  say: (line: string) => void;
  /** The structure check passed and listed what is nearing a size cap. */
  onStructureNote?: (note: string) => void;
}

export type AppVerifyOutcome =
  /** A check failed. `evidence`: screenshots to keep with the failure, when the
   *  failure is one a fixer should see ([] is "keep the text, there are none"). */
  | { kind: "failed"; code: string; detail: string; evidence?: Array<string | undefined> }
  /** Nothing looked at the app: the smoke could not run on this machine.
   *  `noted`: the browser never opened, which the owner must be told. */
  | { kind: "unverified"; detail: string; url?: string; noted: boolean }
  /** It runs clean; the vision judge was not satisfied with how it looks. A
   *  taste verdict, never a broken build. */
  | { kind: "design-noted"; detail: string; shots: Array<string | undefined>; url?: string }
  | { kind: "verified"; url?: string; interacted: boolean; judge: "passed" | "unavailable" | "not-run" };

const failed = (code: string, detail: string, evidence?: Array<string | undefined>): AppVerifyOutcome =>
  ({ kind: "failed", code, detail, ...(evidence ? { evidence } : {}) });

export async function verifyBuiltApp(input: AppVerifyInput): Promise<AppVerifyOutcome> {
  const { appDir, tier } = input;
  // A two-framework hybrid (Next + a serving vite.config, or vice-versa) ships
  // one dead config and a blank page — detectFramework serves ONE, the other's
  // base/HMR config is inert. Reject before smoking, whichever tier this is:
  // the scan is cheap and inert on any app without a "next" signal.
  const hybrid = scanAppForFrameworkHybrid(appDir);
  if (hybrid.hybrid) return failed("framework_hybrid", formatFrameworkHybrid(hybrid.reason));
  // A project that carries the structure kit passes its own check before
  // anything is smoked: the check's output is the fix list, and a smoke of a
  // project that fails its own rules would only bury it. A new build of a
  // project-shaped tier that scaffolded its own project (a creator the
  // harness does not run) gets the kit here first; the single-page tier is
  // not a project and an update is never retrofitted uninvited.
  const adoptKit = input.newBuild && tier !== "quick-html" ? { projectName: basename(appDir) } : undefined;
  const structure = await (input.gates?.structureGate ?? runAppStructureGate)(appDir, input.opId, { adoptKit });
  if (structure.kind === "failed") return failed("structure_check_failed", structure.detail, []);
  if (structure.kind === "passed" && structure.note) {
    input.say(`[structure] ${structure.note}`);
    input.onStructureNote?.(structure.note);
  }
  // A frontend-spa build that shipped a static page instead of a real project
  // FAKED it — the invariant that closes the live-Vite-fake class. Tier-gated
  // so it's inert on every other build. A startup error (no HTML entry) on a
  // real-built SPA is expected pre-dev-server, so the faked check supersedes it.
  if (tier === "frontend-spa") {
    const fake = scanAppForFakedFrontend(appDir);
    if (fake.faked) return failed("faked_frontend_build", formatFakedFrontend(fake.reason));
    // Real project present — the static-HTML scans below would misread it
    // (a Vite index.html legitimately points at /src/main.jsx). Smoke the
    // LIVE dev server instead of a flat file.
    return smokeAndJudge(input, "hard-signals");
  }
  // On-disk truth supersedes the prompt-classified tier: a real framework
  // scaffold (Next/Vite/…) has no static HTML entry, so the scans below
  // would falsely reject it — same reasoning as the frontend-spa branch.
  const detected = detectFramework(appDir).framework;
  if (detected !== "static" && detected !== "unknown") return smokeAndJudge(input, "hard-signals");
  const { errors } = scanAppForStartupErrors(appDir);
  const { violations } = scanAppForBlockedFetch(appDir);
  const { violations: parity } = scanAppForUnverifiedNativeParity(appDir);
  // All three block. They are checked in severity order and each reports its
  // OWN message under its OWN code — previously the messages were joined into
  // a single error whose code was just the first one that matched, so a
  // caller reading the code could not tell which text it had been handed.
  // A startup error is checked first: a blank-on-load app is the most
  // fundamental break, so its text is the one worth acting on.
  if (errors.length > 0) return failed("app_startup_error", formatStartupErrors(errors));
  // The app is served under `connect-src 'self'` (workspace-app-serving.ts),
  // so a raw cross-origin call is not "may fail" — it is refused, and an app
  // whose content depends on it ships an empty shell forever.
  if (violations.length > 0) return failed("blocked_external_fetch", formatBlockedFetchError(violations));
  // A browser preview described as matching a compiled program's output, when
  // that program was never run here, is an unverified claim shipped as fact.
  if (parity.length > 0) return failed("unverified_native_parity", formatUnverifiedNativeParity(parity));
  return smokeAndJudge(input, "strict");
}

/** Where the app is loaded from: its live dev server (hard-signals), a static
 *  page's own backend, or nothing (the smoke serves the folder itself). */
async function smokeTarget(input: AppVerifyInput, mode: AppSmokeGateSpec["mode"]): Promise<{ url?: string } | { noTarget: string }> {
  const appName = basename(input.appDir);
  if (mode !== "hard-signals") {
    // A static page calling its own registered backend is smoked where it
    // runs, still strict: the throwaway origin would 404 every call to it.
    return { url: (await (input.gates?.backendUrlResolver ?? resolveBackendAppUrl)(appName)) ?? undefined };
  }
  let resolved = await (input.gates?.urlResolver ?? resolveDevServerProxyUrl)(appName);
  // No dev-server record. The cli-subprocess path registers one in
  // finalizeFrameworkBuild, but the in-canonical path never does unless
  // the model itself called app_serve_frontend — and a model that never
  // served is exactly the empty-node_modules / black-page failure. So
  // register the detected framework's dev server NOW and smoke it for
  // real, instead of skipping the one gate that catches a blank page.
  if (!resolved) resolved = await registerFrameworkServer(input, appName);
  if (resolved) return { url: resolved };
  // Still no servable dev server: a framework build with nothing to serve
  // at /apps/<id>/ renders blank. That's a build failure, not a skip —
  // the tier's whole promise is a live server.
  return {
    noTarget:
      `This build reported ready but has no servable dev server for "${appName}" — no framework project ` +
      `was scaffolded that LAX can serve at /apps/${appName}/, so the app renders a blank page. Scaffold a ` +
      `REAL project (package.json + the framework config + src/) and start it with app_serve_frontend, or ` +
      `if this is a static app, ship a plain index.html instead.`,
  };
}

/** Layers 2–4: smoke (static build on a local origin under the real serving
 *  policy, strict; or live dev-server, hard-signals), then the vision judge
 *  over the evidence. */
async function smokeAndJudge(input: AppVerifyInput, mode: AppSmokeGateSpec["mode"]): Promise<AppVerifyOutcome> {
  const target = await smokeTarget(input, mode);
  // Distinct code from the smoke's own failure below: "there was nothing
  // to serve" and "it served and then broke" are structurally different
  // and a caller (or a fixer reading the reason) must be able to tell
  // them apart — they were both `app_smoke_failed` before.
  if ("noTarget" in target) return failed("app_no_servable_target", target.noTarget);
  const url = target.url;
  const smoke = await (input.gates?.smokeGate ?? runAppSmokeGate)({ appDir: input.appDir, url, mode, sessionId: input.sessionId });
  const shots = [smoke.screenshotPath, smoke.interactionScreenshotPath];
  if (smoke.verdict === "fail") {
    // Third distinct code, for the same reason app_no_servable_target is the
    // second: "the app is broken" and "this machine could not run the gate"
    // are structurally different outcomes, and a caller that reads only the
    // code must not be told to fix an app that was never shown to be broken.
    const code = smoke.failureKind === "environment" ? "app_smoke_environment_failed" : "app_smoke_failed";
    return failed(code, smoke.detail ?? "smoke failed", shots);
  }
  if (smoke.verdict === "skipped") {
    input.say(`[verify] smoke gate skipped: ${smoke.detail}`);
    // Any classified skip means the BROWSER never opened, so nothing looked
    // at the app — the one condition worth a durable row. An UNclassified
    // skip (skipKind absent) is a future skip reason this note has no claim
    // to describe, so it stays a progress line only.
    return { kind: "unverified", detail: smoke.detail ?? "", url, noted: Boolean(smoke.skipKind) };
  }
  input.say(`[verify] smoke passed — ${url ?? "page"} loaded, mounted, no ${mode === "strict" ? "console" : "uncaught"} errors${smoke.interactionScreenshotPath ? ", survived its primary action" : ""}${smoke.screenshotPath ? ` (evidence: ${smoke.screenshotPath})` : ""}`);
  // Behavior is clean — last question is appearance: does the render look
  // like what was ASKED? Deterministic checks can't see wrong-but-quiet
  // rendering (the black-screen maze that throws nothing).
  const judgeShots = shots.filter((p): p is string => typeof p === "string");
  let judged: "passed" | "unavailable" | "not-run" = "not-run";
  if (input.brief && judgeShots.length > 0) {
    const judgeBrief = smoke.judgeNotes ? `${input.brief}\n\n(${smoke.judgeNotes})` : input.brief;
    const verdict = await (input.gates?.judge ?? runAppVisionJudge)(judgeShots, judgeBrief, input.designSpec);
    if (verdict === null) {
      judged = "unavailable";
      input.say(`[verify] vision judge unavailable (no vision-capable credential) — skipped`);
    } else if (!verdict.ok) {
      // A taste verdict, NOT a broken build. Everything deterministic already
      // passed: it compiled, served, mounted, threw nothing and survived its
      // primary action. Failing the op here reported a working app the same
      // way as a crash — the user watched a landing page they were about to
      // keep get called "failed" because a judge scored its looks (2026-09-16).
      //
      // The repolish loop is the design-verify completion gate, which is
      // capped and deliberately nudge-only for exactly this reason: "a low
      // score must never demote an otherwise-honest outcome"
      // (turn-loop/design-verify.ts).
      const detail =
        `The app renders without errors, but a vision check compared the screenshots against the brief and was not ` +
        `satisfied: ${verdict.reason || "does not look like what was asked"}. ` +
        `Screenshots: ${judgeShots.join(", ")} — read/view them before claiming a fix.`;
      return { kind: "design-noted", detail, shots, url };
    } else {
      judged = "passed";
      input.say(`[verify] vision judge passed — render matches the brief`);
    }
  }
  return { kind: "verified", url, interacted: Boolean(smoke.interactionScreenshotPath), judge: judged };
}

/** Register the detected framework's dev server (the in-canonical path never
 *  does — only CliBuildAdapter calls finalizeFrameworkBuild) so the live smoke
 *  has a URL to load. Null when there is nothing to serve (static/unknown) or
 *  registration failed. */
async function registerFrameworkServer(input: AppVerifyInput, appName: string): Promise<string | null> {
  const finalized = await finalizeFrameworkBuild(
    { appDir: input.appDir, appName, laxPort: selfPort(), registerServer: true },
    input.gates?.finalizeDeps ?? {},
  );
  if (!finalized.handled) return null;  // static/unknown — no framework to serve
  if (!finalized.ok) {
    input.say(`[verify] dev-server registration failed: ${finalized.message}`);
    return null;
  }
  return finalized.url;
}

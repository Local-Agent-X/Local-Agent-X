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
 *      observe it. Static builds load over http from a throwaway local origin
 *      that serves them at the real `/apps/<id>/` mount under the real
 *      workspace-app CSP and request→file resolution (app-serving-policy.ts),
 *      in "strict" mode (any console error fails); framework/full-stack builds
 *      load their LIVE dev-server proxy URL in "hard-signals" mode (uncaught
 *      errors / mount fail; dev-server console chatter rides to the judge
 *      instead). Render evidence lands in .lax-build/smoke.png.
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
 * A smoke that can't run (no browser would launch) SKIPS with a warning — an
 * environment problem is never a build verdict. Whenever the skip is because
 * the BROWSER never opened, the warning is ALSO written as a durable assistant
 * row (app-build-unverified-note.ts), because a stream chunk dies with the live
 * bubble and the user would otherwise never learn that nothing opened their
 * app. That note carries the build's APP_READY URL and report, because being
 * the last assistant row makes it the op's final text for op_wait/op_status/
 * the phone — see that module's header. A dev server that never becomes ready
 * FAILS — a live server is the framework tiers' whole promise.
 *
 * Every gate failure is blocking: any defect any layer finds fails the build.
 * The static scans each report under their OWN code with their own message —
 * they used to be joined into one error whose code was just the highest-
 * priority one, which left a caller unable to tell which defect it read.
 *
 * Every gate failure also emits a canonical USER message carrying the failure
 * text AND the screenshot(s) as image refs (VERIFY_EVIDENCE_MARKER). That row
 * is durable in op_messages; build-session-context reads it on the next
 * update build so the fixer gets the pixels, not just prose.
 *
 * Runner + judge + URL resolver live in app-build-smoke-gate.ts.
 */
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { AppTier } from "../../tools/app-tier.js";
import { getDesignSpec } from "../turn-loop/design-verify.js";
import type { FinalizeFrameworkDeps } from "./app-build-finalize.js";
import { emitFailureEvidence, emitStructureNote, emitUnverifiedNote, emitVerifiedNote } from "./app-build-unverified-note.js";
import type { StructureGateRunner } from "./app-build-structure-gate.js";
import { verifyBuiltApp, type AppVerifyGates, type AppVerifyOutcome } from "./app-build-verify-checks.js";
import { extractText } from "../turn-loop/content-extract.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import {
  runAppSmokeGate,
  type AppSmokeGateRunner,
  type AppVisionJudge,
  type DevServerUrlResolver,
} from "./app-build-smoke-gate.js";

export {
  runAppSmokeGate,
  runAppVisionJudge,
  resolveDevServerProxyUrl,
  resolveBackendAppUrl,
  type AppSmokeGateRunner,
  type AppSmokeGateSpec,
  type AppSmokeGateOutcome,
  type AppVisionJudge,
  type DevServerUrlResolver,
} from "./app-build-smoke-gate.js";

/** The markers of the durable rows this adapter emits (app-build-unverified-
 *  note.ts): the failure evidence a rejected build leaves for its fixer, and the
 *  note a PASSING but unverified build leaves. One import surface for callers. */
export { SMOKE_NO_BROWSER_MARKER, STRUCTURE_NOTE_MARKER, VERIFY_EVIDENCE_MARKER } from "./app-build-unverified-note.js";

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
  /** Test seam: a static page's registered-backend URL (resolveBackendAppUrl). */
  backendUrlResolver?: DevServerUrlResolver;
  /** Test seam: framework-finalize deps (registerDevServer etc.) forwarded to
   *  finalizeFrameworkBuild when the smoke gate must register a dev server the
   *  in-canonical path never did. Production passes nothing (defaults resolve
   *  to the real dev-server module). */
  finalizeDeps?: FinalizeFrameworkDeps;
  /** Test seam: the structure-kit check (app-build-structure-gate.ts). */
  structureGate?: StructureGateRunner;
  /** This op CREATES the app (build_app's `isUpdate` was false). A new build of
   *  a project-shaped tier adopts the structure kit at its done-claim when the
   *  model scaffolded the project itself; an update never does. Unknown (a
   *  persisted op from before the field) counts as an update. */
  newBuild?: boolean;
}

export class AppBuildVerifyAdapter implements Adapter {
  private readonly brief: string;
  private readonly gates: AppVerifyGates;
  private readonly newBuild: boolean;
  constructor(
    private readonly inner: Adapter,
    private readonly appDir: string,
    private readonly tier?: AppTier,
    smokeGate: AppSmokeGateRunner = runAppSmokeGate,
    opts: AppBuildVerifyOptions = {},
  ) {
    this.brief = opts.brief ?? "";
    this.gates = {
      smokeGate, judge: opts.judge, urlResolver: opts.urlResolver, backendUrlResolver: opts.backendUrlResolver,
      finalizeDeps: opts.finalizeDeps, structureGate: opts.structureGate,
    };
    this.newBuild = opts.newBuild ?? false;
  }
  get name(): string { return this.inner.name; }
  get version(): string { return this.inner.version; }

  async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
    // Watch the builder's OWN final assistant row on its way past. It carries
    // the deliverable (`APP_READY: <url>` + the build report), and if the
    // unverified note below has to become the op's last assistant row, it must
    // carry that deliverable forward or op_wait/op_status/the phone get the
    // warning INSTEAD of the app. Pass-through only — every report still goes
    // out unchanged, and only the inner adapter is watched (our own rows below
    // use the raw `report`, so they can never be mistaken for the builder's).
    let builderText = "";
    const watch = (r: AdapterReport): void => {
      if (r.kind === "message_finalized" && r.message.role === "assistant") {
        const text = extractText(r.message.content).trim();
        if (text) builderText = text;
      }
      report(r);
    };
    const result = await this.inner.runTurn(input, watch);
    if (result.terminalReason !== "done") return result;
    // The checks themselves, and what each is for, are app-build-verify-checks.ts
    // (shared with the chat's own check of an app it wrote); here they become
    // this op's reports.
    const outcome = await verifyBuiltApp({
      appDir: this.appDir, tier: this.tier, brief: this.brief, newBuild: this.newBuild,
      opId: input.opId, designSpec: getDesignSpec(input.opId), sessionId: getSessionForOp(input.opId),
      gates: this.gates,
      say: (line) => report({ kind: "stream_chunk", body: { delta: `${line}\n` } }),
      onStructureNote: (note) => emitStructureNote(input, report, note),
    });
    return this.reportOutcome(input, report, result, outcome, builderText);
  }

  /** What the checks found, as this op's reports and its terminal reason. */
  private reportOutcome(
    input: TurnInput,
    report: (r: AdapterReport) => void,
    result: TurnResult,
    outcome: AppVerifyOutcome,
    /** The builder's own final assistant text, forwarded into the notes so
     *  they keep carrying the deliverable (see runTurn). */
    builderText: string,
  ): TurnResult {
    if (outcome.kind === "failed") {
      // Every gate failure a fixer should see leaves its text and screenshots
      // as a durable row first (VERIFY_EVIDENCE_MARKER).
      if (outcome.evidence) emitFailureEvidence(input, report, outcome.detail, outcome.evidence);
      // retryable stays false. It is not a claim about transience (a bind
      // failure often IS transient) — it is what the loop can act on: a
      // retryable report only re-drives the turn when NOTHING happened
      // (reported-adapter-recovery.ts), and by this point the build turn has
      // streamed, finalized the evidence row, and run tools. A `true` here
      // would be inert at best and would re-run a whole build at worst.
      report({ kind: "error", code: outcome.code, message: outcome.detail, retryable: false });
      return { ...result, terminalReason: "error" };
    }
    if (outcome.kind === "unverified") {
      if (outcome.noted) emitUnverifiedNote(input, report, { detail: outcome.detail, builderText, url: outcome.url });
      return result;
    }
    if (outcome.kind === "design-noted") {
      // Evidence first (screenshots + reason), so a repolish pass has
      // something concrete to work from.
      emitFailureEvidence(input, report, outcome.detail, outcome.shots);
      // Then the durable note, which keeps the deliverable: it restates
      // APP_READY so op_wait / op_status / the phone card still hand back the
      // app instead of a complaint about it.
      emitUnverifiedNote(input, report, { detail: outcome.detail, builderText, url: outcome.url });
      report({ kind: "stream_chunk", body: { delta: `[verify] vision judge was not satisfied — delivered anyway, design noted\n` } });
      return result;
    }
    // The durable receipt: the progress lines above die with the live bubble.
    emitVerifiedNote(input, report, { builderText, url: outcome.url, interacted: outcome.interacted, judge: outcome.judge });
    return result;
  }

  abort(reason?: unknown): Promise<void> { return this.inner.abort(reason); }
}

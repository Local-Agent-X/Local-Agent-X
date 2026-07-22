/**
 * Injectable singleton seams for the pre-dispatch gate chain. Every module
 * singleton assertToolCallAllowed consults is declared here as an optional
 * override on PreDispatchCtx.deps, so the whole veto surface is testable
 * through one interface without vi.mock.
 *
 * Behavior contract: each default is EXACTLY the singleton call pre-dispatch
 * made before this file existed, resolved at the same TIME (per call, never
 * hoisted to module scope) — the kill-switch config is hot-reloaded and the
 * local-only policy stays a lazy dynamic import.
 */
import { checkSessionPolicy } from "../session/policy.js";
import { getRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import type { LocalOnlyDecision } from "../local-only-policy.js";
import { getApprovalManager, getToolDecision, getRiskDecision } from "../approval-manager.js";
import { hasCapability, type CapabilityClass } from "../tool-registry.js";
import { opForbidsCapability, planModeForbidsCapability } from "../canonical-loop/public/plan-ledger.js";
import type { ServerEvent } from "../types.js";
import type { RulePack } from "../tool-policy/evaluator.js";
import { makeSpendCapPack } from "../tool-policy/packs/spend-cap-pack.js";
import { makeEgressRefutationPack } from "../tool-policy/packs/egress-refutation-pack.js";

/** The slice of runtime config the pre-dispatch gates actually read:
 *  category kill-switches + the strict local-only flag. */
export type PreDispatchRuntimeFlags = Pick<
  LAXConfig,
  "localOnlyMode" | "enableShell" | "enableHttp" | "enableBrowser" | "enableComputerControl" | "supervisedBrowser"
>;

/** The one ApprovalManager method the gate drives. Structural on purpose so
 *  tests can inject a recording fake without reaching for casts. */
export interface PreDispatchApprovalManager {
  requestApproval(opts: {
    toolName: string;
    toolCallId: string;
    sessionId: string;
    context: string;
    args: Record<string, unknown>;
    alwaysAsk: boolean;
    /** Canonical op id — keys the durable pendingApproval column. */
    opId?: string;
    emit: (event: ServerEvent) => void;
  }): Promise<boolean>;
}

/** Overrides for the module singletons the gate chain reads. Every field is
 *  optional; an absent field means "the real singleton, read at gate time". */
export interface PreDispatchDeps {
  /** Session-scoped runtime toggle (src/session/policy.ts state). */
  checkSessionPolicy?: (sessionId: string, toolName: string) => string | null;
  /** Kill-switches + local-only flag. Read PER CALL — config is hot-reloaded. */
  getRuntimeConfig?: () => PreDispatchRuntimeFlags;
  /** Strict local-only veto. The default preserves today's lazy dynamic import. */
  localOnlyToolDecision?: (
    name: string,
    args: Record<string, unknown>,
    cfg: Pick<LAXConfig, "localOnlyMode">,
  ) => LocalOnlyDecision | Promise<LocalOnlyDecision>;
  /** Per-op instruction-ledger prohibition state. */
  opForbidsCapability?: (opId: string, cls: CapabilityClass) => boolean;
  /** Session-scoped enforced-plan-mode state. */
  planModeForbidsCapability?: (sessionId: string, cls: CapabilityClass) => boolean;
  /** Tool-registry capability classification. */
  hasCapability?: (toolName: string, cls: CapabilityClass) => boolean;
  /** The two singleton-backed rule packs. The other three packs (security /
   *  default-policy / threat) already take their state via PreDispatchCtx. */
  makeSpendCapPack?: () => RulePack;
  makeEgressRefutationPack?: () => RulePack;
  /** Interactive approval prompt sink. */
  getApprovalManager?: () => PreDispatchApprovalManager;
  /** Active autonomy-profile decisions (profile-store singleton). */
  getToolDecision?: typeof getToolDecision;
  getRiskDecision?: typeof getRiskDecision;
  /** Current page URL of the session's live browser backend — read only when
   *  supervised browser mode gates a browser.evaluate. Default reads the
   *  existing backend via src/browser/instance.ts (lazy import: keeps the
   *  browser subsystem off the hot path and avoids an import cycle). An
   *  unknowable URL ("" / throw) fails SAFE toward approval in supervised
   *  mode. */
  getBrowserCurrentUrl?: (sessionId: string) => string | Promise<string>;
  /** Whether the session currently owns a live in-app browser view — read
   *  only when the screen-capture redirect gate sees a screen_capture call.
   *  Default reads the backend map via src/browser/instance.ts (lazy import,
   *  same reasoning as getBrowserCurrentUrl). Unknowable state fails OPEN
   *  (false = no view = capture allowed) — the historic behavior for every
   *  session without an in-app browser. */
  hasInAppBrowserView?: (sessionId: string) => boolean | Promise<boolean>;
}

export type ResolvedPreDispatchDeps = Required<PreDispatchDeps>;

/** Fill every absent override with the current singleton. Called once per
 *  assertToolCallAllowed invocation; the defaults are references to the live
 *  singleton accessors, so each gate still reads state at the moment it runs. */
export function resolvePreDispatchDeps(deps: PreDispatchDeps = {}): ResolvedPreDispatchDeps {
  return {
    checkSessionPolicy: deps.checkSessionPolicy ?? checkSessionPolicy,
    getRuntimeConfig: deps.getRuntimeConfig ?? getRuntimeConfig,
    localOnlyToolDecision:
      deps.localOnlyToolDecision ??
      (async (name, args, cfg) =>
        (await import("../local-only-policy.js")).localOnlyToolDecision(name, args, cfg)),
    opForbidsCapability: deps.opForbidsCapability ?? opForbidsCapability,
    planModeForbidsCapability: deps.planModeForbidsCapability ?? planModeForbidsCapability,
    hasCapability: deps.hasCapability ?? hasCapability,
    makeSpendCapPack: deps.makeSpendCapPack ?? makeSpendCapPack,
    makeEgressRefutationPack: deps.makeEgressRefutationPack ?? makeEgressRefutationPack,
    getApprovalManager: deps.getApprovalManager ?? getApprovalManager,
    getToolDecision: deps.getToolDecision ?? getToolDecision,
    getRiskDecision: deps.getRiskDecision ?? getRiskDecision,
    getBrowserCurrentUrl:
      deps.getBrowserCurrentUrl ??
      (async (sessionId: string) => {
        try {
          const { getBrowserManager } = await import("../browser/instance.js");
          return await getBrowserManager(sessionId).getCurrentUrl();
        } catch {
          return "";
        }
      }),
    hasInAppBrowserView:
      deps.hasInAppBrowserView ??
      (async (sessionId: string) => {
        try {
          const { hasInAppBackend } = await import("../browser/instance.js");
          return hasInAppBackend(sessionId);
        } catch {
          return false;
        }
      }),
  };
}

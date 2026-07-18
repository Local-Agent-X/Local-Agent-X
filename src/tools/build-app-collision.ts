import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ORCHESTRATOR_STATE_FILENAME,
  read as readOrchestratorState,
} from "../auto-build/orchestrator/state.js";

export interface CollisionCheckResult {
  /** When true, the build must NOT proceed — return the error to the agent. */
  blocked: boolean;
  /** When true, the build is a deliberate update of an existing app. */
  isUpdate: boolean;
  /** Agent-facing error message when blocked. */
  errorMessage?: string;
}

export type ProductBuildOwnership =
  | "planned"
  | "planned-with-stale-state"
  | "orchestrated"
  | "stale-state";

export function resolveProductBuildOwnership(
  hasPlan: boolean,
  hasStateMarker: boolean,
  hasRunState: boolean,
): ProductBuildOwnership | null {
  if (hasRunState) return "orchestrated";
  if (hasPlan && hasStateMarker) return "planned-with-stale-state";
  if (hasPlan) return "planned";
  if (hasStateMarker) return "stale-state";
  return null;
}

export function checkProductBuildOwnership(
  appDir: string,
  appName: string,
): CollisionCheckResult {
  const stateMarkerPath = resolve(appDir, ORCHESTRATOR_STATE_FILENAME);
  const runState = readOrchestratorState(appDir);
  const ownership = resolveProductBuildOwnership(
    existsSync(resolve(appDir, "spec", "plan.md")),
    existsSync(stateMarkerPath),
    runState !== null,
  );
  if (ownership === "orchestrated") {
    return {
      blocked: true,
      isUpdate: false,
      errorMessage:
        `App "${appName}" is owned by Product Build (${ORCHESTRATOR_STATE_FILENAME}, phase=${runState?.phase}). ` +
        `Quick Build (build_app) is blocked to avoid corrupting orchestrated work. ` +
        `Call build_plan_status with project_dir "${appDir}" to inspect it; ` +
        `if it is halted, call build_plan_resume.`,
    };
  }
  if (ownership === "planned") {
    return {
      blocked: true,
      isUpdate: false,
      errorMessage:
        `App "${appName}" is owned by Product Build (spec/plan.md). ` +
        `Quick Build (build_app) is blocked to preserve the approved plan. ` +
        `Call run_build_plan with project_dir "${appDir}" to start it.`,
    };
  }
  if (ownership === "planned-with-stale-state") {
    return {
      blocked: true,
      isUpdate: false,
      errorMessage:
        `App "${appName}" is owned by Product Build (spec/plan.md), but its state marker at ` +
        `"${stateMarkerPath}" is malformed or stale. Quick Build (build_app) remains blocked. ` +
        `After confirming no Product Build must be recovered, delete that stale marker, ` +
        `then call run_build_plan with project_dir "${appDir}".`,
    };
  }
  if (ownership === "stale-state") {
    return {
      blocked: true,
      isUpdate: false,
      errorMessage:
        `App "${appName}" has a malformed or stale Product Build state marker at "${stateMarkerPath}". ` +
        `build_plan_status and build_plan_resume cannot use this invalid state. ` +
        `After confirming no Product Build must be recovered, delete that stale marker and retry build_app; ` +
        `otherwise restore spec/plan.md and restart Product Build.`,
    };
  }
  return { blocked: false, isUpdate: false };
}

/**
 * Guard against the silent-overwrite collision: two builds picking the same
 * slug (e.g. both Codex and Grok choosing `graphing-calculator`) would let
 * the second one stomp the first because `isUpdate` used to be inferred from
 * directory existence alone. Now `isUpdate` is an explicit caller intent
 * (the `update` arg), and a collision without that flag is refused with a
 * message that tells the LLM exactly how to disambiguate.
 *
 * Pure helper so the decision logic is unit-testable without queuing an op.
 */
export function checkBuildCollision(
  appDir: string,
  appName: string,
  updateFlag: boolean,
): CollisionCheckResult {
  const productBuild = checkProductBuildOwnership(appDir, appName);
  if (productBuild.blocked) return productBuild;

  const exists = existsSync(resolve(appDir, "index.html"));
  if (!exists) return { blocked: false, isUpdate: false };
  if (updateFlag) return { blocked: false, isUpdate: true };
  return {
    blocked: true,
    isUpdate: false,
    errorMessage:
      `App "${appName}" already exists at workspace/apps/${appName}/index.html. ` +
      `Refusing to overwrite silently. Pick one:\n` +
      `  • Modifying the existing app (user said "make it green", "update X", "add Y to it") ` +
      `→ call build_app again with update: true.\n` +
      `  • New, separate app (different variant or different brief) ` +
      `→ pick a different name (e.g. "${appName}-v2", "${appName}-green").`,
  };
}

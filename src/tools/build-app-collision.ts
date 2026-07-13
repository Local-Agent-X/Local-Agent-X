import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface CollisionCheckResult {
  /** When true, the build must NOT proceed — return the error to the agent. */
  blocked: boolean;
  /** When true, the build is a deliberate update of an existing app. */
  isUpdate: boolean;
  /** Agent-facing error message when blocked. */
  errorMessage?: string;
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

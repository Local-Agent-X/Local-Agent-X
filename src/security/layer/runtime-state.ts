import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { FileAccessMode, InlineEvalPolicy } from "./types.js";

export interface SecurityRuntimeIdentity {
  workspace: string;
  fileAccessMode: FileAccessMode;
  inlineEvalPolicy: InlineEvalPolicy;
  allowedPaths: Array<{ sessionId: string; path: string }>;
}

export function snapshotSecurityRuntime(
  workspace: string,
  fileAccessMode: FileAccessMode,
  inlineEvalPolicy: InlineEvalPolicy,
  paths: Map<string, Set<string>>,
  sessionId?: string,
): SecurityRuntimeIdentity {
  const allowedPaths = [...paths.entries()]
    .filter(([key]) => key === "_global" || (!!sessionId && key === sessionId))
    .flatMap(([sessionId, entries]) => [...entries].map(path => ({ sessionId, path })))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.path.localeCompare(b.path));
  return { workspace, fileAccessMode, inlineEvalPolicy, allowedPaths };
}

/**
 * Category kill-switches (shell/http/browser) plus the local-only and
 * supervised-browser toggles. These live in the runtime config, not in the
 * SecurityLayer, but they are security policy the pre-dispatch gates enforce
 * (killSwitchBlock / localOnlyToolDecision / supervisedEvaluateBlock), so they
 * belong INSIDE the sealed policy fingerprint: a delegated/container runtime
 * that cannot reproduce the host's toggles must fail the runtime-surface check
 * CLOSED rather than fall back to schema defaults (all categories ON,
 * localOnly OFF, supervised OFF) and quietly run tools the host disabled.
 */
export interface CategoryPolicyFingerprintInput {
  enableShell: boolean;
  enableHttp: boolean;
  enableBrowser: boolean;
  localOnlyMode: boolean;
  supervisedBrowser: boolean;
}

export function fingerprintSecurityPolicy(
  fileAccessMode: FileAccessMode,
  inlineEvalPolicy: InlineEvalPolicy,
  egressMode: string,
  egressAllowlistConfigured: boolean,
  egressAllowlist: string[],
  localServicePorts: string[],
  selfPort: string,
  categoryPolicy: CategoryPolicyFingerprintInput,
): string {
  return createHash("sha256").update(JSON.stringify({
    fileAccessMode,
    inlineEvalPolicy,
    egressMode,
    egressAllowlistConfigured,
    egressAllowlist: [...egressAllowlist].sort(),
    localServicePorts: [...localServicePorts].sort(),
    selfPort,
    enableShell: categoryPolicy.enableShell,
    enableHttp: categoryPolicy.enableHttp,
    enableBrowser: categoryPolicy.enableBrowser,
    localOnlyMode: categoryPolicy.localOnlyMode,
    supervisedBrowser: categoryPolicy.supervisedBrowser,
  })).digest("hex");
}

export function restoreSecurityAllowedPaths(
  entries: Array<{ sessionId: string; path: string }>,
  clear: () => void,
  add: (path: string, sessionId?: string) => void,
): void {
  if (!Array.isArray(entries) || entries.length > 1_000) throw new Error("invalid persisted allowed paths");
  for (const entry of entries) {
    if (!entry || typeof entry.sessionId !== "string" || !entry.sessionId
      || typeof entry.path !== "string" || !isAbsolute(entry.path) || entry.path.includes("\0")) {
      throw new Error("invalid persisted allowed path");
    }
  }
  clear();
  for (const entry of entries) {
    add(entry.path, entry.sessionId === "_global" ? undefined : entry.sessionId);
  }
}

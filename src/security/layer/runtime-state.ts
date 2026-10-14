import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { FileAccessMode, InlineEvalPolicy } from "./types.js";
import type { PathArgSpec } from "../../tool-policy/tool-policies.types.js";

export interface SecurityRuntimeIdentity {
  workspace: string;
  fileAccessMode: FileAccessMode;
  inlineEvalPolicy: InlineEvalPolicy;
  allowedPaths: Array<{ sessionId: string; path: string }>;
}

/** The paths a declared path arg carries: one string, a real array of
 *  strings, or (json) a JSON-array string. Returns null when an array holds a
 *  non-string element — the caller fails closed, since a value the gate cannot
 *  read as a path must not reach the tool as one. A json arg whose string is
 *  not a JSON array is gated as the one path it spells: generate_video treats
 *  a bare string as a single reference, so skipping it would skip the read. */
export function pathArgPaths(raw: unknown, json?: boolean): string[] | null {
  if (Array.isArray(raw)) return raw.every((x): x is string => typeof x === "string") ? raw : null;
  if (typeof raw !== "string" || raw.length === 0) return [];
  if (!json) return [raw];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [raw];
  }
  return Array.isArray(parsed) ? pathArgPaths(parsed) : [raw];
}

/** Every path one PathArgSpec names in a call's args, or null when a value
 *  cannot be read as paths (fail closed). `each` specs read the path off every
 *  element of an array-of-objects arg (op_submit_batch.tasks[].context_files);
 *  an element that is not an object fails closed too. */
export function declaredPaths(args: Record<string, unknown>, spec: PathArgSpec): string[] | null {
  const raw = args[spec.arg];
  if (!spec.each) return pathArgPaths(raw, spec.json);
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const paths = pathArgPaths((item as Record<string, unknown>)[spec.each], spec.json);
    if (paths === null) return null;
    out.push(...paths);
  }
  return out;
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

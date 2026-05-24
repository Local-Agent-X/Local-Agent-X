// Render-verification gate. Tier 1.A of the app-builder loop: when an op
// edits files under workspace/apps/<id>/ and says "done", we wait briefly
// for the preview iframe's runtime-error pipe to forward any errors it
// observed after the reload. If errors land, we suppress the terminal,
// inject the errors as a synthetic user message on the next turn, and
// let the same model fix what it broke. The environment becomes the
// critic — no model switching, no second-pass grader.
//
// Per-op state: a buffer of errors keyed by opId, plus a retry counter
// so an unfixable bug can't spin forever. Both clear on op terminal via
// clearRenderVerifyStateForOp, hooked into state-machine.ts.

import type { ToolCall } from "../contract-types.js";

export interface PreviewRuntimeError {
  kind: string;       // "error" | "rejection" | "console" | "csp" | "resource" | "blank"
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
  ts: number;
}

const ERRORS = new Map<string, PreviewRuntimeError[]>();
const RETRIES = new Map<string, number>();

const MAX_RETRIES = 2;
const POLL_INTERVAL_MS = 250;
export const DEFAULT_WAIT_MS = 3000;

export function pushPreviewRuntimeError(opId: string, err: PreviewRuntimeError): void {
  let bucket = ERRORS.get(opId);
  if (!bucket) {
    bucket = [];
    ERRORS.set(opId, bucket);
  }
  bucket.push(err);
}

export function drainPreviewRuntimeErrors(opId: string): PreviewRuntimeError[] {
  const bucket = ERRORS.get(opId);
  if (!bucket || bucket.length === 0) return [];
  ERRORS.delete(opId);
  return bucket;
}

export function peekPreviewRuntimeErrorCount(opId: string): number {
  return ERRORS.get(opId)?.length ?? 0;
}

export function getRenderVerifyRetries(opId: string): number {
  return RETRIES.get(opId) ?? 0;
}

export function bumpRenderVerifyRetries(opId: string): number {
  const next = (RETRIES.get(opId) ?? 0) + 1;
  RETRIES.set(opId, next);
  return next;
}

export function clearRenderVerifyStateForOp(opId: string): void {
  ERRORS.delete(opId);
  RETRIES.delete(opId);
}

/** Test-only — drop all per-op render-verify state. */
export function _resetRenderVerifyState(): void {
  ERRORS.clear();
  RETRIES.clear();
}

// A turn touched an app if at least one tool call wrote/edited a path
// under workspace/apps/<id>/. Read tools are not enough — we only care
// when the model could have changed what the preview renders.
const MUTATING_FILE_TOOLS = new Set(["write", "edit", "build_app"]);
const APP_PATH_RE = /(^|[\\/])workspace[\\/]apps[\\/][^\\/]+[\\/]/;

export function turnTouchedAppFiles(toolCalls: ToolCall[]): boolean {
  for (const call of toolCalls) {
    if (!MUTATING_FILE_TOOLS.has(call.tool)) continue;
    const args = call.args as { path?: unknown; file_path?: unknown } | null | undefined;
    const raw = args?.path ?? args?.file_path;
    if (typeof raw !== "string") {
      // build_app doesn't pass a path; the tool name alone is the signal.
      if (call.tool === "build_app") return true;
      continue;
    }
    if (APP_PATH_RE.test(raw.replace(/\\/g, "/"))) return true;
  }
  return false;
}

// Terse, factual nudge body. Frontier models do worse with pep-talk framing;
// they need the data plus the environment context they may not know. Tag
// prefixes mirror the iframe-side kind values: error/rejection/console from
// the original pipe, csp/resource/blank from the Tier-1 patch.
const CSP_LINE =
  "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'";

function tagForKind(kind: string): string {
  switch (kind) {
    case "rejection": return "Rejection";
    case "console":   return "console.error";
    case "csp":       return "CSP";
    case "resource":  return "404";
    case "blank":     return "Empty";
    default:          return "Error";
  }
}

export function formatRuntimeErrorsForAgent(errors: PreviewRuntimeError[]): string {
  if (errors.length === 0) return "";
  const lines: string[] = [];
  for (const e of errors) {
    const tag = tagForKind(e.kind);
    // Empty + CSP carry their full message; non-empty source/line is appended
    // for error/console/rejection/resource where it disambiguates.
    const where = (e.source && e.line)
      ? " at " + e.source + ":" + e.line + (e.col ? ":" + e.col : "")
      : (e.source ? " at " + e.source : "");
    lines.push("- [" + tag + "] " + e.message + (tag === "Empty" || tag === "CSP" ? "" : where));
  }
  return (
    "Preview iframe loaded but reported issues:\n\n" +
    lines.join("\n") +
    "\n\nThe iframe runs under this CSP: " + CSP_LINE + ". " +
    "External CDNs and Google Fonts are blocked at the network layer. " +
    "Files resolve relative to index.html.\n\n" +
    "Fix and re-run."
  );
}

export interface WaitForErrorsOptions {
  totalMs?: number;
  pollMs?: number;
  /** Test hook — override the default setTimeout-based poll. */
  sleep?: (ms: number) => Promise<void>;
}

/** Poll the per-op buffer for up to `totalMs`. Resolves with the first
 *  non-empty drain or [] if nothing landed in time. */
export async function waitForPreviewRuntimeErrors(
  opId: string,
  opts: WaitForErrorsOptions = {},
): Promise<PreviewRuntimeError[]> {
  const totalMs = opts.totalMs ?? DEFAULT_WAIT_MS;
  const pollMs = opts.pollMs ?? POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  // Fast path — errors already buffered before the gate started.
  if (peekPreviewRuntimeErrorCount(opId) > 0) {
    return drainPreviewRuntimeErrors(opId);
  }
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (peekPreviewRuntimeErrorCount(opId) > 0) {
      return drainPreviewRuntimeErrors(opId);
    }
  }
  return [];
}

export interface RenderVerifyGateResult {
  /** Errors that landed in time, already formatted as the nudge body. */
  nudge: string;
  /** The retry counter AFTER this gate decided to fire. */
  retryCount: number;
  /** True when the gate is suppressing the terminal "done". */
  shouldRetry: boolean;
  /** When true, retry cap reached — caller leaves terminalReason alone but
   *  may want to surface that errors were observed and not fixed. */
  capReached: boolean;
}

/** Decide whether to suppress this turn's terminal "done" based on
 *  preview runtime errors. Pure orchestration over the helpers above so
 *  the turn-loop call site stays a one-liner.
 *
 *  Contract:
 *    - Call only when terminalReason === "done" and the turn touched app
 *      files. Caller does that gate.
 *    - Waits up to opts.totalMs for errors. If none → returns shouldRetry
 *      false, no state mutations.
 *    - If errors land but the retry cap is already hit → returns
 *      shouldRetry false + capReached true; errors are dropped (drained
 *      into the formatted nudge string but not pushed into op_messages by
 *      this function — the caller decides). */
export async function runRenderVerifyGate(
  opId: string,
  opts: WaitForErrorsOptions = {},
): Promise<RenderVerifyGateResult> {
  const errors = await waitForPreviewRuntimeErrors(opId, opts);
  if (errors.length === 0) {
    return { nudge: "", retryCount: getRenderVerifyRetries(opId), shouldRetry: false, capReached: false };
  }
  const priorRetries = getRenderVerifyRetries(opId);
  if (priorRetries >= MAX_RETRIES) {
    return {
      nudge: formatRuntimeErrorsForAgent(errors),
      retryCount: priorRetries,
      shouldRetry: false,
      capReached: true,
    };
  }
  const next = bumpRenderVerifyRetries(opId);
  return {
    nudge: formatRuntimeErrorsForAgent(errors),
    retryCount: next,
    shouldRetry: true,
    capReached: false,
  };
}

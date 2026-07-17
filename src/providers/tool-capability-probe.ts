/**
 * LIVE tool-calling evidence for OpenAI-compat endpoints — ADVISORY ONLY.
 *
 * The registry's other populators trust METADATA (Ollama /api/show
 * capabilities) or wait for a real turn to FAIL (the 400 learn-on-failure,
 * the loopback empty-with-tools latch). Vendor metadata lies both ways — a
 * model can advertise "tools" and still never emit one, or lack the flag and
 * work fine. This module gathers BEHAVIORAL evidence: did a structured
 * tool_call actually come back when one was asked for?
 *
 * SEPARATION OF POWERS — verified evidence informs UI/routing; only real
 * turn failures latch. This module NEVER calls markNoToolSupport. A probe is
 * a synthetic, single-shot exchange: a reasoning-first model can burn the
 * token budget before its first call, an engine can accept tool_choice:
 * "required" and silently ignore it, and a model that emits tool calls as
 * TEXT is served fine by the tool-call-in-text fallback — none of which
 * proves the model can't do tools on a real turn. Stripping tools stays
 * exclusively with the existing failure-grounded latches; toolsVerified
 * {ok:false} is a recorded observation, nothing more, and tools keep being
 * sent.
 *
 * Recording (persistent model-capabilities registry, LEARNED layer):
 *   - structured ping call            → toolsVerified {ok:true}
 *   - clean finish_reason:"stop" with no structured call on BOTH attempts
 *     (the forced one included)       → toolsVerified {ok:false}
 *   - anything else — transport/HTTP errors, truncation ("length"), a
 *     missing/other finish_reason     → null, NOTHING recorded; the
 *     once-guard is memory-only, so an inconclusive key retries next run.
 *
 * Scheduling is LAZY and NON-BLOCKING: fired fire-and-forget after a
 * completed chat turn, at most one HTTP attempt per (baseURL, model) per
 * process. Containment here is literal-loopback ONLY — callers additionally
 * gate on the latch policy at the call site (openai-compat's
 * shouldLatchNoToolSupport), and this module's own floor means no caller
 * can point the probe at cloud. LAN runtimes (manual or discovered) are
 * deliberately NOT probed: someone else's box, unknown per-request cost —
 * the same posture as the /api/show probe.
 *
 * Free evidence beats a probe: when a real turn already produced a
 * structured tool call, noteLiveToolCallEvidence records {ok:true} directly
 * and no HTTP request is ever spent on that key.
 */

import { hasNoToolSupport, getToolsVerified, markToolsVerified } from "./types.js";
import { isLoopbackUrl } from "../local-only-policy.js";
import { createLogger } from "../logger.js";

const logger = createLogger("providers.tool-probe");

const DEFAULT_TIMEOUT_MS = 8000;
/** Reasoning-first local models burn tokens before their first call — give
 *  them room. A truncated ("length") completion is inconclusive regardless. */
const PROBE_MAX_TOKENS = 256;

export interface ToolProbeOptions {
  /** Per-request timeout (worst case two requests: auto, then required). */
  timeoutMs?: number;
  /** Bearer for local engines that demand one (e.g. vLLM with --api-key). */
  apiKey?: string;
}

const PING_TOOL = {
  type: "function",
  function: {
    name: "ping",
    description: "reply with a ping",
    parameters: { type: "object", properties: {} },
  },
} as const;

type AttemptOutcome =
  | { kind: "tool_call" } // structured ping call came back (any finish_reason)
  | { kind: "no_call_stop" } // clean finish_reason:"stop", no structured call
  | { kind: "inconclusive" } // 2xx, no call, but truncated/missing/other finish
  | { kind: "http_error"; status: number }
  | { kind: "transport" }; // network error / timeout / unparseable body

/** "ping" under casing/punctuation noise ("Ping", "functions.ping", "ping_tool"). */
function isPingName(name: unknown): boolean {
  return typeof name === "string" && name.toLowerCase().replace(/[^a-z0-9]/g, "").includes("ping");
}

interface WireChoice {
  message?: { tool_calls?: unknown };
  finish_reason?: unknown;
}

function firstChoice(body: unknown): WireChoice | undefined {
  return (body as { choices?: WireChoice[] })?.choices?.[0];
}

function hasStructuredPingCall(choice: WireChoice | undefined): boolean {
  const calls = choice?.message?.tool_calls;
  if (!Array.isArray(calls)) return false;
  return calls.some((c) => isPingName((c as { function?: { name?: unknown } })?.function?.name));
}

async function attemptOnce(
  baseURL: string,
  model: string,
  toolChoice: "auto" | "required",
  opts: ToolProbeOptions,
): Promise<AttemptOutcome> {
  try {
    const r = await fetch(`${baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        // Local engines accept any key; only send a REAL bearer — the literal
        // "ollama" placeholder means no auth (same rule as the /api/show probe).
        ...(opts.apiKey && opts.apiKey !== "ollama" ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "call the ping tool" }],
        tools: [PING_TOOL],
        tool_choice: toolChoice,
        max_tokens: PROBE_MAX_TOKENS,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!r.ok) return { kind: "http_error", status: r.status };
    const choice = firstChoice(await r.json());
    // A structured call is proof regardless of the stop label (engines report
    // "tool_calls", "stop", or nothing at all when calling).
    if (hasStructuredPingCall(choice)) return { kind: "tool_call" };
    // No call: only a CLEAN stop is a real "declined to call". A truncated
    // ("length") or unlabeled completion may have died before its call —
    // reasoning-first models routinely spend tokens thinking first.
    return choice?.finish_reason === "stop" ? { kind: "no_call_stop" } : { kind: "inconclusive" };
  } catch {
    return { kind: "transport" };
  }
}

/**
 * Live-check whether (baseURL, model) emits a structured tool_call, and
 * record the ADVISORY observation in the capability registry. Never throws,
 * never latches — see the module header for the separation of powers.
 *
 *   {ok:true}  — a structured ping call came back (either attempt)
 *   {ok:false} — clean finish_reason:"stop" with no structured call on BOTH
 *                attempts, the tool_choice:"required" one included
 *   null       — anything else: transport/HTTP errors (including engines
 *                that 400 on tool_choice:"required"), truncation, missing
 *                finish_reason. Inconclusive; nothing recorded.
 *
 * This is the raw primitive: callers own endpoint policy. Scheduling and
 * the loopback containment live in maybeVerifyToolSupport.
 */
export async function verifyToolSupport(
  baseURL: string,
  model: string,
  opts: ToolProbeOptions = {},
): Promise<{ ok: boolean } | null> {
  const first = await attemptOnce(baseURL, model, "auto", opts);
  if (first.kind === "http_error" || first.kind === "transport") return null;
  if (first.kind === "tool_call") {
    markToolsVerified(baseURL, model, true);
    logger.info(`live probe: ${model} returned a structured tool_call — verified`);
    return { ok: true };
  }
  // No call under "auto" proves nothing — a chatty model may just answer.
  // Force the call once. Engines that reject tool_choice:"required" 400
  // here; that (like any transport/HTTP error) is inconclusive, not a fail.
  const second = await attemptOnce(baseURL, model, "required", opts);
  if (second.kind === "tool_call") {
    markToolsVerified(baseURL, model, true);
    logger.info(`live probe: ${model} returned a structured tool_call when forced — verified`);
    return { ok: true };
  }
  if (first.kind === "no_call_stop" && second.kind === "no_call_stop") {
    // Asked, then forced, and BOTH times the model finished CLEANLY without
    // a structured call. Recorded as advisory evidence only — tools keep
    // being sent; only real turn failures latch (module header).
    markToolsVerified(baseURL, model, false);
    logger.info(
      `live probe: ${model} cleanly declined a structured tool_call twice — recorded advisory ok:false (tools still sent)`,
    );
    return { ok: false };
  }
  // Truncation ("length"), a missing/other finish_reason, or an errored
  // forced attempt — can't tell. Record nothing; retry next process run.
  return null;
}

/**
 * One HTTP attempt per (baseURL, model) per process — claimed synchronously
 * before the first await, so it doubles as the in-flight dedupe. Memory-only
 * on purpose: a definitive result persists in the registry and stops
 * re-fires via the store checks; an inconclusive null retries next run.
 */
const attempted = new Set<string>();

/**
 * Free positive evidence from a REAL turn: it already produced ≥1 structured
 * tool call, which is the very fact the HTTP probe exists to discover.
 * Record {ok:true} and spend nothing. Same loopback containment as the
 * probe; skips the write when {ok:true} is already on file so a busy
 * tool-calling model doesn't rewrite the registry every turn. An older
 * advisory {ok:false} is superseded — live evidence wins. Never throws.
 */
export function noteLiveToolCallEvidence(baseURL: string | undefined, model: string): void {
  try {
    if (!baseURL || !model || !isLoopbackUrl(baseURL)) return;
    if (getToolsVerified(baseURL, model)?.ok === true) return; // already on file
    markToolsVerified(baseURL, model, true);
    logger.info(`live evidence: ${model} emitted a structured tool_call on a real turn — verified without a probe`);
  } catch {
    // Advisory bookkeeping must never surface into a turn.
  }
}

/**
 * Lazy call-site policy: fire-and-forget after a completed chat turn. Adds
 * zero latency to any request — the caller `void`s the promise — and only
 * ever reaches literal-loopback endpoints. Keys with any existing answer
 * (a real no-tools latch, or prior verified evidence) are never probed.
 */
export async function maybeVerifyToolSupport(
  baseURL: string | undefined,
  model: string,
  apiKey?: string,
): Promise<void> {
  try {
    if (!baseURL || !model) return;
    const key = `${baseURL}::${model}`;
    if (attempted.has(key)) return;
    // Containment floor: literal loopback only, so no caller can point the
    // probe at cloud or at a LAN box (deliberately unprobed — see header).
    if (!isLoopbackUrl(baseURL)) return;
    if (hasNoToolSupport(baseURL, model)) return; // a real latch already answers
    if (getToolsVerified(baseURL, model)) return; // evidence already on file
    attempted.add(key);
    await verifyToolSupport(baseURL, model, { apiKey });
  } catch {
    // Verification is advisory — it must never surface into a turn.
  }
}

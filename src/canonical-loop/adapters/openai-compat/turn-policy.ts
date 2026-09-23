/**
 * Per-turn policy for the OpenAI-compat adapter, split out of openai-compat.ts
 * (400-LOC gate): two pure decisions about an ENDPOINT — whether an empty
 * reply with tools attached may latch the model off tools, and whether text
 * that looks like a tool call may be rescued into one. Both key on the host,
 * never on the turn, so they live beside the other openai-compat/* helpers.
 */
import { getToolsVerified } from "../../../providers/types.js";

/**
 * Whether an empty-with-tools turn should PERMANENTLY latch the model to
 * no-tool mode (via markNoToolSupport) vs just retry-without-tools for this
 * one turn.
 *
 * Latch ONLY for loopback/local endpoints. The latch exists for genuinely
 * tool-incapable local models (qwen2:7b on local Ollama): there, an empty
 * response really does mean "this model can't do tools," and latching saves a
 * dead first leg on every later turn. For CLOUD frontier providers (Gemini's
 * compat endpoint, xAI, OpenAI, Ollama Turbo) an empty completion is a
 * transient/payload issue, NOT proof of no tool support — Gemini returned
 * empty with 98 tools attached, the latch flipped it to chat-only for the
 * whole process, and it then narrated every later turn without ever calling a
 * tool. So cloud endpoints get the per-turn retry but never the permanent kill.
 */
export function shouldLatchNoToolSupport(baseURL: string | undefined, model?: string): boolean {
  if (!baseURL) return false;
  // A model with a structured tool call on file is not tool-incapable; an
  // empty reply from it is a sampling accident and gets the per-turn retry
  // only. Without this, one empty after a real tool call latched the install
  // off native tools for that model (op-outcomes, 2026-09-23).
  if (model && getToolsVerified(baseURL, model)?.ok === true) return false;
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Strip IPv6 brackets if URL parsing left them.
  host = host.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}

/**
 * Frontier endpoints served through this adapter that emit structured
 * tool_calls reliably. Text-rescue there only adds risk: a JSON example the
 * model shows in its answer would dispatch as a real call. Tagged call syntax
 * left in the final text still trips the unresolved-tool-intent gate's
 * wire-format nudge; a bare JSON envelope just stands as the reply.
 */
const NATIVE_TOOL_CALL_HOSTS = new Set(["api.x.ai", "generativelanguage.googleapis.com"]);

export function shouldRescueTextToolCalls(baseURL: string | undefined): boolean {
  if (!baseURL) return true;
  try {
    return !NATIVE_TOOL_CALL_HOSTS.has(new URL(baseURL).hostname.toLowerCase());
  } catch {
    return true;
  }
}

/**
 * Which reasoning param, if any, this (endpoint, model) should receive.
 *
 * Split out of openai-http.ts: the question has grown three independent
 * inputs — whether the model's thinking DEPTH is dialable, whether the caller
 * wants thinking OFF, and whether this endpoint has already 400'd on the param
 * — and answering it inline left the decision spread across a capability
 * check, a gate and the body builder, where the three could drift apart.
 */
import { hasParamUnsupported } from "../types.js";
import { PROVIDERS, isHttpProvider } from "../registry.js";
import { PROVIDER_IDS, type ProviderId } from "../provider-ids.js";
import { isLocalModelEndpoint } from "../../local-runtimes/model-endpoint.js";
import {
  clampNoneForCloud,
  effortForChatCompletions,
  DEFAULT_REASONING_EFFORT,
  THINKING_OFF,
  type WireReasoningEffort,
} from "../reasoning-effort.js";

// Reasoning capability lives per-provider on PROVIDERS[id].capabilities.reasoning
// (src/providers/registry.ts). The adapter doesn't know which provider it's
// running for at call time — baseURL is the only hint — so match by scanning
// the registry for any http provider whose baseURL matches and whose reasoning
// regex matches the model. Cloud endpoints only: a local runtime is asked
// (resolveReasoningParam), never matched by name.
export function isReasoningCapable(baseURL: string | undefined, model: string): boolean {
  if (!baseURL) return false;
  for (const id of PROVIDER_IDS) {
    const meta = PROVIDERS[id as ProviderId];
    if (!isHttpProvider(meta)) continue;
    const metaURL = typeof meta.baseURL === "string" ? meta.baseURL : null;
    if (metaURL && baseURL.startsWith(metaURL)) {
      return meta.capabilities.reasoning ? meta.capabilities.reasoning.test(model) : false;
    }
  }
  // A cloud baseURL no provider row owns (Ollama Cloud, a custom URL): the
  // OSS reasoning families by name, the only catalog there is for it.
  return /deepseek-r1|qwen.*reasoning|gpt-oss|glm-4\.7/i.test(model);
}

export interface ReasoningParamDecision {
  /** Include `reasoning_effort` on the request body at all. */
  send: boolean;
  /** The value to send when `send` is true. */
  value: "none" | "minimal" | "low" | "medium" | "high";
}

/**
 * A LOCAL endpoint is sent the user's depth for every model: which of its
 * models reason is the runtime's to say, and it says so by accepting the
 * param or by 400-ing it once, which openai-param-rejections.ts learns per
 * (baseURL, model) and this then stops sending. Until 2026-10-31 a local
 * model was sent the param only when a name regex recognised it, so the
 * Think picker did nothing for qwen3.8 on Ollama (the discovered Ollama
 * runtime now rides /api/chat, where ollama-native.ts picks the level from
 * the model's own reported levels; this path is every other local runtime).
 *
 * "none" — thinking OFF — is worth sending to a runtime that reasons BY
 * DEFAULT. Local endpoints only. Verified accepted on Ollama 0.34.2 /v1 for
 * both test models (HTTP 200, `reasoning_len` 0, tool call still emitted —
 * docs/harness/phase0-evidence/probe-results.v1-extras.json, probes
 * 2/8/12/18) and unverified anywhere else, so every other endpoint gets the
 * nearest real depth instead of a value that might 400.
 */
export function resolveReasoningParam(args: {
  baseURL: string | undefined;
  model: string;
  effort: WireReasoningEffort | undefined;
}): ReasoningParamDecision {
  const wantsOff = args.effort === THINKING_OFF;
  const local = isLocalModelEndpoint(args.baseURL);
  const offHere = wantsOff && local;
  const send =
    (local || isReasoningCapable(args.baseURL, args.model)) &&
    !hasParamUnsupported(args.baseURL, args.model, "reasoning_effort");
  const value = effortForChatCompletions(
    offHere ? THINKING_OFF : clampNoneForCloud(args.effort ?? DEFAULT_REASONING_EFFORT),
  );
  return { send, value };
}

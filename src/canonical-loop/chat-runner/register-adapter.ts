// Provider → adapter dispatch. Picks the right canonical adapter based on
// prepared.provider and registers it for the op. Three branches:
//   - anthropic   → AnthropicAdapter (CLI transport)
//   - codex       → CodexAdapter
//   - everything else → OpenAICompatAdapter (one wire shape, swapped
//     baseURL+apiKey per provider). For "local" we additionally check the
//     per-model cloud-Ollama set, so picking a Turbo model from inside
//     the local dropdown still routes to the cloud endpoint.

import type { PreparedAgentRequest } from "../../agent-request/types.js";
import { stableSystemPrefixLength } from "../../agent-request/prepare-request/build-system-prompt.js";
import { registerAdapterForOp } from "../runtime.js";
import { createAnthropicAdapter } from "../adapters/anthropic.js";
import type { OpenAICompatTarget } from "../adapters/openai-compat.js";

export async function registerAdapterForChat(
  opId: string,
  prepared: PreparedAgentRequest,
  sessionId: string,
  resolvedTarget?: OpenAICompatTarget | null,
): Promise<void> {
  const forcedToolChoice = prepared.toolChoice;

  if (prepared.provider === "anthropic") {
    registerAdapterForOp(opId, () =>
      createAnthropicAdapter({
        systemPrompt: prepared.systemPrompt,
        model: prepared.model,
        sessionId,
        forcedToolChoice,
        // Chat streams real "Thinking" via the direct-HTTP OAuth path when a
        // subscription token is resolvable; auto-falls back to the CLI proxy
        // otherwise. Sub-agents/builds omit this and stay on the CLI loop.
        preferDirectHttp: true,
        // Split the system prompt into [stable | volatile] instead of shipping
        // one block. Computed HERE, inside the lazy factory, so it reflects the
        // final prompt: prepare-request appends learned-protocol/file-
        // attachments, create-op appends op grounding, and the capability-aware
        // degradation pass can drop sections — all of which land before the
        // adapter is actually constructed.
        //
        // Without this, one block carried the breakpoint at the END of the
        // system tier, so any per-turn churn in the dynamic tail (memory
        // blocks, turn directives, riders) missed AND re-wrote the whole
        // ~40k-token tier at 1.25x. With it, the stable head reads from cache
        // instead, and the volatile tail is still covered by the conversation
        // breakpoint below — nothing that was cached stops being cached.
        //
        // The head is the core-identity/* parts (config/system-prompt.md, one
        // section per `## ` heading, same bytes) + runtime-context ONLY: ~76.9 KB /
        // ~21,976 est tokens, 77.6% of the system prompt (measured
        // 2026-09-07 by scripts/measure-prompt-prefix.mjs, snapshot
        // catalog-sha256=276510d75470). Do NOT quote the larger ~26.5k figure
        // from this file's history — that counted app-manifest and agents-md,
        // which stableSystemPrefixLength now excludes precisely because a
        // filesystem watcher rewrites the manifest and the agent itself edits
        // AGENTS.md, so both churn during exactly the long app-build and
        // self-edit sessions this optimisation exists for. estimateTokens is
        // ceil(len/3.5), not a tokenizer.
        systemStablePrefixLen: stableSystemPrefixLength(prepared.renderedPromptSections),
        // Cache the conversation prefix, not just system+tools.
        //
        // Without this the breakpoint sits at the end of the system blocks and
        // never advances, so every turn re-sends the whole growing message tail
        // as uncached input at full rate. Measured on a real 160-turn chat op:
        // cacheRead pinned at 88,104 for all 160 turns, cacheCreate zero after
        // turn 0, and 3.5M tokens of tail re-sent at 10x the cache-read price.
        //
        // Safe here because the prefix BELOW the breakpoint is byte-stable
        // within an op — the same measurement proves it, since a volatile
        // system prompt would have driven cacheRead to zero rather than a
        // constant. Voice gates this on voiceSplit.fullyStable because its
        // system prompt has a volatile tail; chat's does not. A breakpoint
        // under a volatile prefix is the failure mode to avoid: it writes
        // every turn and never reads.
        //
        // Compaction is the regime this has to survive, and it only does
        // because the summary is PINNED per op (turn-loop/compact-summary-
        // cache.ts). The view is never persisted, so an over-threshold op
        // re-compacts every turn and the split point advances every turn: an
        // unpinned summarizer would emit different bytes at message index 0
        // every turn and this breakpoint would never read back a thing. With
        // the pin, index 0 is byte-identical until the summarized head grows
        // past TURN_SUMMARY_REFRESH_MIN_GROWTH — then one miss and one
        // re-write, which IS the normal price of compaction. If that pin is
        // ever removed, this flag stops paying on long chats.
        cacheConversation: true,
      }),
    );
    return;
  }

  if (prepared.provider === "codex") {
    const { createCodexAdapter } = await import("../adapters/codex.js");
    registerAdapterForOp(opId, () =>
      createCodexAdapter({
        systemPrompt: prepared.systemPrompt,
        model: prepared.model,
        reasoningEffort: prepared.reasoningEffort,
        sessionId,
        forcedToolChoice,
      }),
    );
    return;
  }

  // Gemini uses its NATIVE generateContent API, not the OpenAI-compat shim:
  // the compat endpoint returns empty STOP completions nondeterministically on
  // tool-laden requests (an unfixable Google bug). resolveOpenAICompatTarget
  // still resolves the key/base; the native adapter takes the key.
  if (prepared.provider === "gemini") {
    const { resolveOpenAICompatTarget } = await import("../adapters/openai-compat.js");
    const target = await resolveOpenAICompatTarget("gemini", prepared);
    if (!target) {
      throw new Error("gemini has no usable target — check API key config");
    }
    const { createGeminiNativeAdapter } = await import("../adapters/gemini-native.js");
    registerAdapterForOp(opId, () =>
      createGeminiNativeAdapter({
        model: prepared.model,
        apiKey: target.apiKey,
        systemPrompt: prepared.systemPrompt,
        temperature: prepared.temperature,
        thinking: /gemini-(2\.5|3)/i.test(prepared.model),
        sessionId,
        forcedToolChoice,
      }),
    );
    return;
  }

  // OpenAI-compat providers: local, ollama-cloud, xai, openai, custom.
  // One adapter, one wire shape — only the baseURL + apiKey swap per provider.
  const { createOpenAICompatAdapter } = await import("../adapters/openai-compat.js");
  const { localModelEvidenceForResolvedTarget, resolveOpenAICompatTarget } =
    await import("../adapters/openai-compat/resolve-target.js");
  // Local per-model routing (Turbo cloud override, LM Studio/vLLM/llama.cpp
  // runtime lookup) lives inside resolveOpenAICompatTarget — one seam.
  const target = resolvedTarget
    ?? await resolveOpenAICompatTarget(prepared.provider, prepared, prepared.model);
  if (!target) {
    // No usable target (e.g. ollama-cloud picked but no key configured,
    // or custom provider without baseURL). Surface the failure cleanly
    // by registering a no-op adapter that errors on first runTurn.
    throw new Error(`provider ${prepared.provider} has no usable OpenAI-compat target — check API key and base URL config`);
  }
  const finalTarget = target;
  prepared.localModelCapabilityProfile = localModelEvidenceForResolvedTarget(
    prepared.provider,
    finalTarget,
  );
  registerAdapterForOp(opId, () =>
    createOpenAICompatAdapter({
      systemPrompt: prepared.systemPrompt,
      model: prepared.model,
      baseURL: finalTarget.baseURL,
      apiKey: finalTarget.apiKey,
      temperature: prepared.temperature,
      reasoningEffort: prepared.reasoningEffort,
      sessionId,
      forcedToolChoice,
    }),
  );
}

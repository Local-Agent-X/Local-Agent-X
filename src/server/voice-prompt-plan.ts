import {
  renderPromptSection,
  type RenderedPromptSection,
} from "../context/system-prompt-builder.js";

export interface VoicePromptSplit {
  /** Reassembled system prompt: static sections → voice tail → dynamic tail. */
  systemPrompt: string;
  /** Byte offset where the volatile tail begins, or undefined when the whole
   *  prompt is stable this turn (no dynamic sections rendered). */
  stableLen: number | undefined;
  /** True when no dynamic sections rendered — the full system prompt is
   *  byte-stable across turns, so conversation-history caching can hit too. */
  fullyStable: boolean;
  /** Section plan matching systemPrompt's actual order (telemetry + local
   *  degradation both require plan text ≡ prompt text). */
  sections: RenderedPromptSection[];
}

/**
 * Voice prompt-cache split. The base prompt interleaves per-turn dynamic
 * sections (memory retrieval, notices) into the same string as the large
 * static prefix, so consecutive voice turns were byte-different and missed
 * the Anthropic prompt cache on the whole tools+system tier every turn.
 *
 * Reorder into [static sections, voice-mode tail, dynamic sections] — the
 * builder already emits static before dynamic, so this is a no-op reorder in
 * practice — and report where the stable bytes end. stream-api.ts turns that
 * boundary into a two-block system with the cache breakpoint on the stable
 * block (see StreamOptions.systemStablePrefixLen).
 *
 * Safety valve: if the base sections don't reassemble into baseSystemPrompt
 * exactly (an override path bypassed the section builder), fall back to the
 * legacy shape — append the tail, no split — rather than ship a prompt that
 * diverges from what the caller prepared.
 */
export function buildVoicePromptSplit(
  base: readonly RenderedPromptSection[],
  baseSystemPrompt: string,
  voiceTail: string,
): VoicePromptSplit {
  const voiceSection = renderPromptSection({
    id: "voice-mode",
    label: "Voice Mode",
    type: "static",
    policy: "required",
    text: voiceTail,
  });

  const concatenated = base.map((s) => s.text).join("");
  if (concatenated !== baseSystemPrompt) {
    return {
      systemPrompt: baseSystemPrompt + voiceTail,
      stableLen: undefined,
      fullyStable: false,
      sections: [...base, voiceSection],
    };
  }

  const stable = base.filter((s) => s.type === "static");
  const volatile = base.filter((s) => s.type !== "static");
  const stableText = stable.map((s) => s.text).join("") + voiceTail;
  const volatileText = volatile.map((s) => s.text).join("");
  return {
    systemPrompt: stableText + volatileText,
    stableLen: volatile.length > 0 ? stableText.length : undefined,
    fullyStable: volatile.length === 0,
    sections: [...stable, voiceSection, ...volatile],
  };
}

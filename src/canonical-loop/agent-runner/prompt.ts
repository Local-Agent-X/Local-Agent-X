import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { createPromptTelemetry, remeasurePromptTelemetry } from "../../prompt-telemetry.js";
import { toolSchemaFormatForDispatch } from "../../providers/shared/tool-shape.js";
import { applyCapabilityAwarePromptProfile } from "../prompt-preflight.js";
import type { LocalModelCapabilityProfile } from "../../local-runtimes/index.js";
import type { CanonicalAgentOptions } from "./types.js";
import { foldSystemRowsIntoPrompt } from "../chat-runner/message-convert.js";
import { appendSystemPromptSection } from "../../context/system-prompt-builder.js";
import { localPromptSplit, recalledContextText } from "../chat-runner/local-prompt-split.js";

/** Final section-aware prompt seam shared by every non-chat canonical caller. */
export async function prepareCanonicalAgentPrompt(
  options: CanonicalAgentOptions,
  history: ChatCompletionMessageParam[],
  profile: LocalModelCapabilityProfile | null,
): Promise<void> {
  const plannedPrompt = options.renderedPromptSections.map((section) => section.text).join("");
  if (plannedPrompt !== options.systemPrompt) {
    throw new Error("Canonical agent prompt sections do not match systemPrompt bytes");
  }

  // op_messages has no system role, so seeding drops the history's system rows:
  // the /api/compact summary and truncateHistory's digest. Fold them into the
  // prompt as createChatOp does for chat — a spoken turn on a compacted thread
  // lost the summary. A prompt that already carries them is left alone.
  if (!options.renderedPromptSections.some((section) => section.id === "system-history")) {
    const folded = foldSystemRowsIntoPrompt(options.systemPrompt, history);
    appendSystemPromptSection(options, {
      id: "system-history",
      label: "System History",
      type: "dynamic",
      policy: "required",
      text: folded.slice(options.systemPrompt.length),
    });
  }

  if (!options.promptTelemetry) {
    options.promptTelemetry = createPromptTelemetry({
      profile: "full",
      provider: options.provider,
      model: options.model,
      prompt: options.systemPrompt,
      tools: options.tools,
      allToolCount: options.tools.length,
      historyMessageCount: history.length,
      sections: options.renderedPromptSections.map((section) => section.measurement),
    });
  }

  applyCapabilityAwarePromptProfile(options, profile);
  const toolSchemaFormat = toolSchemaFormatForDispatch(
    options.provider,
    options.promptTelemetry.toolSchemaFormat,
    options.preferAnthropicDirectHttp === true,
  );
  options.promptTelemetry = remeasurePromptTelemetry({
    baseline: options.promptTelemetry,
    prompt: options.systemPrompt,
    tools: options.tools,
    historyMessageCount: history.length,
    toolSchemaFormat,
    sections: options.renderedPromptSections.map((section) => section.measurement),
  });
}

/**
 * A turn saved to a chat thread, on a local wire: send chat's stable prefix
 * (options.savedToChat). Runs once the prompt's sections are final (the
 * degradation pass above has run), as chat's does in its adapter factory, so
 * both read the same split. Returns the recall row's text for the op seed, or
 * null when the prompt stays whole.
 */
export function splitForChatThread(options: CanonicalAgentOptions, sessionId: string): string | null {
  if (!options.savedToChat) return null;
  const split = localPromptSplit({
    provider: options.provider as Parameters<typeof localPromptSplit>[0]["provider"],
    model: options.model,
    renderedPromptSections: options.renderedPromptSections,
  }, sessionId);
  if (!split) return null;
  options.systemPrompt = split.head;
  return recalledContextText(split.tail);
}

// System prompt assembly: combines the base prompt (or override) with all
// the per-turn blocks (provider hint, notification hint, cold-start hint,
// background completions, tool prompt section) and provider riders. Also
// owns the build-intent CLI nudge that pins Anthropic CLI turns to
// build_app even when tool_choice gets dropped.

import type { LAXConfig, ToolDefinition } from "../../types.js";
import type { MemoryIndex } from "../../memory.js";
import type { IntegrationRegistry } from "../../integrations.js";
import { loadSystemPrompt } from "../../config-loader.js";
import { createLogger } from "../../logger.js";
import { providerRiderFor } from "./provider-riders.js";

const logger = createLogger("agent-request.prepare-request.sysprompt");

const PROVIDER_NAMES: Record<string, string> = {
  codex: "OpenAI Codex", anthropic: "Anthropic Claude", xai: "xAI Grok",
  openai: "OpenAI", local: "Local (Ollama)", gemini: "Google Gemini",
};

const COLD_START_VERBS = /\b(build|create|make|deploy|publish|launch|set\s+up|put\s+\S+\s+(live|online)|ship|generate|scaffold|spin\s+up)\b/i;

export interface BuildSystemPromptInput {
  message: string;
  sessionId: string;
  config: LAXConfig;
  memoryIndex: MemoryIndex;
  integrations: IntegrationRegistry;
  allAgentTools: ToolDefinition[];
  systemPromptOverride?: string;
  bridgeContext?: string;
  // Resolved + context — passed in from the orchestrator after build-context
  // and tool-selection have run.
  resolvedProvider: string;
  resolvedModel: string;
  contextBlock: string;
  relevantMemories: string;
  smartContext: string;
  memoryContext: string;
  memoryNotifications: Array<{ message: string; priority: number }>;
  memoryCurateBlock: string;
  // Forced-intent signal from tool-selection — drives the build_app CLI
  // nudge appended at the end when provider=anthropic.
  forceBuildIntent: boolean;
  intentReason?: string;
}

export async function buildSystemPrompt(input: BuildSystemPromptInput): Promise<string> {
  const providerHint = `\n\n[System: You are currently powered by ${PROVIDER_NAMES[input.resolvedProvider] || input.resolvedProvider}, model: ${input.resolvedModel}.]`;
  const integrationsContext = input.integrations.getAgentContext();

  let notificationHint = "";
  if (input.memoryNotifications.length > 0) {
    const topNotifs = input.memoryNotifications.sort((a, b) => b.priority - a.priority).slice(0, 2);
    notificationHint = "\n\n[Naturally weave into your response: " + topNotifs.map(n => n.message).join(" | ") + "]";
  }

  // Per-tool usage guidance. Built over allAgentTools (NOT the filtered
  // tool set) because the keyword/RAG filters sometimes drop a tool's
  // behavioral nudge while still including the tool in the API call —
  // model sees the tool but loses the "USE PROACTIVELY" encouragement.
  // Live regression: chat where browser was needed but didn't fire,
  // because the message had no obvious browser keyword. Spending the
  // ~3-5KB on the full nudge set is cheaper than missed tool calls.
  // Codex used to skip this entirely "to save tokens" but live testing
  // (transformforfitness deploy, 2026-05-01) showed Codex stalled on a
  // cold-start ship task without the proactive memory_search nudge.
  let toolPromptSection = "";
  try {
    const { buildToolPromptSection } = await import("../../tool-prompt-builder.js");
    toolPromptSection = buildToolPromptSection(input.allAgentTools);
  } catch { /* best-effort */ }

  // Cold-start nudge — applies to BOTH providers, but disproportionately
  // helps Codex which doesn't auto-call memory_search the way Anthropic does
  // when the user kicks off a project that might have prior context. Scoped
  // to ship/build/deploy class messages so we don't burn tokens nudging the
  // agent on simple chats.
  if (COLD_START_VERBS.test(input.message)) {
    toolPromptSection += "\n\n[COLD-START HINT] This message looks like the start of a project/deploy/build task. BEFORE writing code, run memory_search on the project name, domain, or business name in case there's prior context (URLs, prior decisions, brand assets, user preferences) from earlier sessions. Cold-starting without checking memory first is a real failure mode — the agent reinvents stuff that was already discussed and ships thinner output. 1-2 memory_search calls = cheap; missing context = expensive iteration.";
  }

  // Drain pending background-op completions for this session so the agent
  // can narrate them naturally on this turn (per the agent-narrates pattern
  // — see ops/pending-notifications.ts for rationale).
  let backgroundCompletionsBlock = "";
  try {
    const { drainPendingNotifications, formatNotificationsForSystemPrompt } = await import("../../ops/pending-notifications.js");
    const { cancelIdleNudge, markSessionExplicitNotify, recordSessionLastMessage } = await import("../../ops/idle-nudge.js");
    cancelIdleNudge(input.sessionId);
    markSessionExplicitNotify(input.sessionId, input.message);
    recordSessionLastMessage(input.sessionId, input.message);
    const pending = drainPendingNotifications(input.sessionId);
    if (pending.length > 0) {
      backgroundCompletionsBlock = formatNotificationsForSystemPrompt(pending);
      logger.info(`[chat] injecting ${pending.length} background completion(s) into system prompt for sess=${input.sessionId}`);
    }
  } catch { /* best-effort */ }

  // Short-reply context handling moved to the base system prompt. Two
  // constitutional rules in config/system-prompt.md ("Directives are commands"
  // + "Short replies are continuations") cover this without per-turn regex
  // detection. Anthropic-style: feed the model durable principles upfront,
  // trust it to apply them. The earlier regex pile-up (QUESTION_END_RE +
  // REITERATION_RE) was a maintenance trap — every new phrasing variant
  // ("hello?", "and?", "still waiting", "you didn't do it") needed another
  // pattern. The constitutional rule covers all of those by intent, not text.
  const shortReplyContextBlock = "";

  const providerRider = providerRiderFor(input.resolvedProvider);

  let systemPrompt: string;
  if (input.systemPromptOverride) {
    // Sub-agents provide their own prompt
    systemPrompt = input.systemPromptOverride + backgroundCompletionsBlock + shortReplyContextBlock + input.memoryCurateBlock + providerRider;
  } else {
    // Use full prompt for all providers. The empty-response issue was caused
    // by reasoning: { effort: "low" } in codex-client.ts, not prompt size.
    // The full prompt contains behavioral instructions the agent needs.
    // Prefer hot-reloadable config file over static config object
    const basePrompt = loadSystemPrompt() || input.config.systemPrompt;

    const { createSystemPromptBuilder } = await import("../../context-builder.js");
    const contextBuilder = createSystemPromptBuilder({
      basePrompt,
      providerHint,
      toolPromptSection,
      integrationsContext,
      memoryDir: (input.memoryIndex as unknown as { memoryDir?: string }).memoryDir,
      contextBlock: input.contextBlock,
      relevantMemories: input.relevantMemories,
      smartContext: input.smartContext,
      memoryContext: input.memoryContext,
      notificationHint,
      bridgeContext: input.bridgeContext,
    });
    systemPrompt = (await contextBuilder.build()) + backgroundCompletionsBlock + shortReplyContextBlock + input.memoryCurateBlock + providerRider;
  }

  // CLI/OAuth nudge for build_app. The Anthropic CLI path ignores the
  // tool_choice the orchestrator sets. Without an inline directive, Opus
  // will sometimes call write/edit/glob to create app files directly
  // instead of going through build_app — which means no canonical op,
  // no AGENTS sidebar card, no streaming progress, no cancel button.
  // Append a strong directive to the system prompt for this turn only
  // so the model picks build_app even when tool_choice is dropped.
  if (input.forceBuildIntent && input.resolvedProvider === "anthropic") {
    systemPrompt +=
      `\n\n--- TURN DIRECTIVE ---\n` +
      `Intent classifier identified this turn as a build_app request: ${input.intentReason ?? "(no reason)"}.\n` +
      `You MUST call the build_app tool for this. Do NOT call write, edit, or glob to create the app files inline — ` +
      `that path skips canonical-loop tracking and the user will see no progress card. ` +
      `build_app spawns a background op that streams in the AGENTS sidebar and can be cancelled. ` +
      `If the user's request is small enough that you could write it inline, you should STILL use build_app — ` +
      `the user explicitly asked for an app.\n` +
      `--- END TURN DIRECTIVE ---\n`;
  }

  return systemPrompt;
}

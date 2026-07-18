// System prompt assembly: combines the base prompt (or override) with all
// the per-turn blocks (provider hint, notification hint, cold-start hint,
// background completions, tool prompt section) and provider riders. Also
// owns the build-intent CLI nudge that pins Anthropic CLI turns to
// build_app even when tool_choice gets dropped.

import type { LAXConfig, ToolDefinition } from "../../types.js";
import type { MemoryIndex } from "../../memory/index.js";
import type { IntegrationRegistry } from "../../integrations/index.js";
import { loadSystemPrompt } from "../../config-loader.js";
import { createLogger } from "../../logger.js";
import { modelFamilyRiderFor, providerRiderFor } from "./provider-riders.js";
import type { FileAccessMode } from "../../security/layer/index.js";
import { loadFileAccessMode } from "../../security/layer/index.js";
import { harnessNotice } from "../../context/system-prompt-builder.js";

const logger = createLogger("agent-request.prepare-request.sysprompt");

const PROVIDER_NAMES: Record<string, string> = {
  codex: "OpenAI Codex", anthropic: "Anthropic Claude", xai: "xAI Grok",
  openai: "OpenAI", local: "Local (Ollama)", gemini: "Google Gemini",
};

const COLD_START_VERBS = /\b(build|create|make|deploy|publish|launch|set\s+up|put\s+\S+\s+(live|online)|ship|generate|scaffold|spin\s+up)\b/i;

/**
 * Per-turn grounding for the live file-access mode. The model is otherwise
 * never told which of the three modes is active, so it guesses — and guesses
 * restrictively, refusing reads it is actually permitted (worst on Grok, which
 * was observed refusing an Unrestricted-mode read as "outside the sandbox"
 * without ever calling the tool). Stating the active policy forces a refusal to
 * come from a real tool result, not an assumption. Pure + exported for testing.
 */
export function fileAccessGroundingBlock(mode: FileAccessMode): string {
  switch (mode) {
    case "unrestricted":
      return harnessNotice("FILE ACCESS", "Mode: UNRESTRICTED. You can read ANY file on this computer. A read fails ONLY if the file does not exist or is a blocked credential/key file — nothing else. Do not refuse a read on any other grounds: call the tool and report the real result.");
    case "common":
      return harnessNotice("FILE ACCESS", "Mode: COMMON. You can read the workspace, the project, ~/.lax, and the user's content folders (Documents, Downloads, Desktop, Pictures, Videos, Music). Paths outside those are blocked; credential/key files are always blocked. Attempt the read; if it is genuinely outside the allowed roots, say so in one line and mention the user can switch to Unrestricted in Settings — don't claim you are simply unable.");
    case "workspace":
      return harnessNotice("FILE ACCESS", "Mode: WORKSPACE-ONLY. Reads are limited to the workspace folder and ~/.lax. Reads elsewhere are blocked BY POLICY, not by a missing tool. Attempt the read; if it is blocked, say so in one line and tell the user they can switch to Common or Unrestricted in Settings — don't claim you are unable.");
  }
}

export interface BuildSystemPromptInput {
  message: string;
  sessionId: string;
  config: LAXConfig;
  memoryIndex: MemoryIndex;
  integrations: IntegrationRegistry;
  allAgentTools: ToolDefinition[];
  /** The tools actually LOADED into this turn's API schema (selectTools output).
   *  The deferred-tool manifest is the complement allAgentTools − loadedTools,
   *  so the model can see every unloaded tool by name and load it via
   *  tool_search. Omit → no manifest (back-compat for callers that don't narrow). */
  loadedTools?: ToolDefinition[];
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
  // "force" = fully-specified build ask (hard hand-off directive); "lean" =
  // thin/one-line build ask (prefer build_app but ask 2-3 questions first).
  // Only set when forceBuildIntent is true.
  buildMode?: "force" | "lean";
  intentReason?: string;
  /** Canonical Quick/Product/continuation decision for this turn. */
  buildTurnDirective?: string;
}

export async function buildSystemPrompt(input: BuildSystemPromptInput): Promise<string> {
  const providerHint = `\n\n[System: You are currently powered by ${PROVIDER_NAMES[input.resolvedProvider] || input.resolvedProvider}, model: ${input.resolvedModel}.]`;
  const integrationsContext = input.integrations.getAgentContext();

  let notificationHint = "";
  if (input.memoryNotifications.length > 0) {
    const topNotifs = input.memoryNotifications.sort((a, b) => b.priority - a.priority).slice(0, 2);
    notificationHint = harnessNotice("MEMORY NOTIFICATION", "Naturally weave into your response: " + topNotifs.map(n => n.message).join(" | "));
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
    const { buildToolPromptSection, buildDeferredToolManifest } = await import("../../tools/tool-prompt-builder.js");
    toolPromptSection = buildToolPromptSection(input.allAgentTools);
    // Deferred-tool manifest: name every tool NOT loaded into this turn's
    // schema so the model can reach it via tool_search instead of fail-
    // discovering or denying. This is what lets the Anthropic-strong path
    // (tool-selection.ts) ship a filtered set rather than the whole inventory —
    // the schema shrinks, the cold cache-write shrinks, and nothing goes
    // invisible (loaded ∪ manifested = full catalog).
    if (input.loadedTools) {
      toolPromptSection += buildDeferredToolManifest(input.allAgentTools, input.loadedTools);
    }
  } catch { /* best-effort */ }

  // Cold-start nudge — applies to BOTH providers, but disproportionately
  // helps Codex which doesn't auto-call memory_search the way Anthropic does
  // when the user kicks off a project that might have prior context. Scoped
  // to ship/build/deploy class messages so we don't burn tokens nudging the
  // agent on simple chats.
  if (COLD_START_VERBS.test(input.message)) {
    toolPromptSection += harnessNotice("COLD-START HINT", "This message looks like the start of a project/deploy/build task. BEFORE writing code, run memory_search on the project name, domain, or business name in case there's prior context (URLs, prior decisions, brand assets, user preferences) from earlier sessions. Cold-starting without checking memory first is a real failure mode — the agent reinvents stuff that was already discussed and ships thinner output. 1-2 memory_search calls = cheap; missing context = expensive iteration.");
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

  // Local models also get a model-family rider: provider "local" spans every
  // local runtime and model family, so provider-level dispatch alone can't
  // target family failure modes (plain-text tool syntax, leaked reasoning
  // tags, think-budget burnout). Joins the same dynamic tail as providerRider,
  // after it. This seam runs fresh every turn, downstream of the turn-context
  // cache (which stores only memory context keyed on session+mode, never
  // prompt bytes), so a model-varying rider can't poison any cache; and being
  // local-only it never touches cloud providers' stable prompt-cache prefix.
  const modelFamilyRider =
    input.resolvedProvider === "local" ? modelFamilyRiderFor(input.resolvedModel) : "";

  // Per-turn file-access grounding — see fileAccessGroundingBlock. Appended in
  // BOTH branches so sub-agents reading files are grounded too. Best-effort:
  // a config read failure must never break prompt assembly.
  let fileAccessBlock = "";
  try {
    fileAccessBlock = fileAccessGroundingBlock(loadFileAccessMode());
  } catch { /* best-effort */ }

  let systemPrompt: string;
  if (input.systemPromptOverride) {
    // Sub-agents provide their own prompt
    systemPrompt = input.systemPromptOverride + backgroundCompletionsBlock + shortReplyContextBlock + input.memoryCurateBlock + fileAccessBlock + providerRider + modelFamilyRider;
  } else {
    // Use full prompt for all providers. The empty-response issue was caused
    // by reasoning: { effort: "low" } in codex-client.ts, not prompt size.
    // The full prompt contains behavioral instructions the agent needs.
    // Prefer hot-reloadable config file over static config object
    const basePrompt = loadSystemPrompt() || input.config.systemPrompt;

    const { createSystemPromptBuilder } = await import("../../context/system-prompt-builder.js");
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
    systemPrompt = (await contextBuilder.build()) + backgroundCompletionsBlock + shortReplyContextBlock + input.memoryCurateBlock + fileAccessBlock + providerRider + modelFamilyRider;
  }

  // build_app hand-off directive. Fires for EVERY provider (not just the
  // Anthropic CLI/OAuth path that ignores tool_choice) because the failure it
  // prevents — the main agent building the app ITSELF in parallel with the
  // background op — showed up worst on Grok/GPT, which previously got no
  // directive at all and so ran cargo + send_image inline, duplicating the
  // worker's build. The inline-build tools are also stripped from this turn's
  // toolset (tool-selection.ts) as the hard guarantee; this directive explains
  // WHY they're gone so the model hands off cleanly instead of flailing.
  if (input.buildTurnDirective) {
    systemPrompt += harnessNotice("TURN DIRECTIVE", input.buildTurnDirective);
  } else if (input.forceBuildIntent && input.buildMode !== "lean") {
    systemPrompt += harnessNotice("TURN DIRECTIVE",
      `Intent classifier identified this turn as a build_app request: ${input.intentReason ?? "(no reason)"}.\n` +
      `Call the build_app tool — that is the ONLY way to build this. The build then runs as a background op (the "side agent") that owns the ENTIRE build: it runs the real toolchain, produces the artifact, and delivers the result to the user itself when done. ` +
      `Do NOT build it yourself this turn — no bash/cargo/compiler, no write/edit of source files, no send_image of a result you produced. Building it twice wastes minutes of compute and confuses the user with a duplicate output. ` +
      `After calling build_app, just briefly tell the user it's building and they'll see it when it's ready.`);
  } else if (input.forceBuildIntent && input.buildMode === "lean") {
    // Lean build ask: right intent, thin spec. Prefer build_app but DISCOVER
    // first — a one-line ask ("build me a page for my gym") shipped a generic
    // page with zero discovery when it hard-forced. No pin fires this turn, so
    // the model is free to ask before building.
    systemPrompt += harnessNotice("TURN DIRECTIVE",
      `The user is asking to build something (${input.intentReason ?? "runnable app/page/tool"}), but the ask is thin — the specifics aren't stated. ` +
      `If you want to build a runnable app, build_app is the right tool (the build runs as a background op that owns the whole build — don't build it inline with bash/write/edit). ` +
      `But do NOT build blind: if the spec is one line, first ask 2-3 short clarifying questions (purpose, audience, must-have features), then call build_app once you know what to make. ` +
      `A generic page nobody asked for is worse than one clarifying question.`);
  }

  return systemPrompt;
}

// System prompt assembly: combines the base prompt (or override) with all
// the per-turn blocks (provider hint, notification hint, background
// completions, tool prompt section) and provider riders. Also
// owns the turn directive for an explicit build route (/app-build, Product
// Build continuation).

import type { LAXConfig, ToolDefinition } from "../../types.js";
import type { MemoryIndex } from "../../memory/index.js";
import type { IntegrationRegistry } from "../../integrations/index.js";
import { loadSystemPrompt } from "../../config-loader.js";
import { createLogger } from "../../logger.js";
import { modelFamilyRiderFor, providerRiderFor } from "./provider-riders.js";
import type { FileAccessMode } from "../../security/layer/index.js";
import { loadFileAccessMode } from "../../security/layer/index.js";
import {
  harnessNotice,
  type RenderedPromptSection,
  type SystemPromptBuildResult,
} from "../../context/system-prompt-builder.js";
import { channelContextBlock } from "../../channel-context.js";
import type { ChannelKind } from "../types.js";

const logger = createLogger("agent-request.prepare-request.sysprompt");

const PROVIDER_NAMES: Record<string, string> = {
  codex: "OpenAI Codex", anthropic: "Anthropic Claude", xai: "xAI Grok",
  openai: "OpenAI", local: "Local (Ollama)", gemini: "Google Gemini",
};

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

/**
 * Sections that carry `type: "static"` but are NOT byte-stable turn-to-turn, so
 * they must not sit inside a cache-anchored prefix. Each one is here for a
 * checked reason, not a guess:
 *
 *  - `tool-guidance`: contains the deferred-tool manifest, which is the
 *    complement of the selected tool set (buildDeferredToolManifest) — stable
 *    for a session only when the tool set is (profile toolRouting "mission",
 *    or a strong model), per-message otherwise.
 *  - `project-catalog`: derived from the memory dir (60 s cache); the agent
 *    writing a memory mid-op changes it.
 *  - `integrations`: IntegrationRegistry.getAgentContext(), which reflects live
 *    connector state and can change when a connector is added or gated.
 *
 * `app-manifest` and `agents-md` used to be listed here. The manifest renders
 * per-app file counts the watcher rewrites during app-build / self_edit; it is
 * now snapshotted per session (context/session-prompt-snapshot.ts). AGENTS.md
 * is re-read every build on purpose — an edit must reach the next message — and
 * its bytes only change when the rules do, so it stays in the prefix and costs
 * one cache miss per real edit.
 *
 * That leaves core-identity/* + runtime-context + app-manifest + agents-md +
 * provider-hint as the prefix: stable for the session, invalidated only when a
 * new session snapshots changed files or config/system-prompt.md changes. (The
 * base prompt is one section per `## ` heading — config-loader's
 * basePromptSections — joined with "", so the walk sums the same bytes the
 * single `core-identity` section once contributed.)
 *
 * Not fixable by skipping: `recall-reflex` (~1.5 KB, genuinely byte-stable) sits
 * AFTER `tool-guidance` in the builder's section order, so accumulating it would
 * require skipping over a volatile section in the MIDDLE. The result would no
 * longer be a contiguous byte prefix of `systemPrompt`, which is the one
 * property `systemPrompt.slice(0, stableLen)` in stream-api depends on. The walk
 * therefore stops dead at the first volatile section, on purpose.
 */
const TURN_VARIANT_STATIC_SECTIONS = new Set([
  "tool-guidance",
  "project-catalog",
  "integrations",
]);

/**
 * Length of the leading run of provably byte-stable system-prompt text, for
 * StreamOptions.systemStablePrefixLen (anthropic-client/stream-api.ts:36).
 *
 * Without it the Anthropic lane ships ONE system block carrying the breakpoint,
 * so any churn in the dynamic tail (memory blocks, turn directives, riders)
 * re-writes the whole ~40k-token system tier at the 1.25x cache-write rate. The
 * voice lane already splits (server/voice-ws.ts:321); chat passed nothing.
 *
 * Returns a JS string index, NOT a byte count — stream-api slices with
 * `systemPrompt.slice(0, stableLen)`, so the unit must match `String.length`.
 *
 * Walks from the START and stops at the first section that is dynamic or
 * turn-variant, which is what makes the result a genuine PREFIX: the builder
 * emits all static sections before all dynamic ones, but
 * `appendSystemPromptSection` can append later, so "sum of every static
 * section" would not be a prefix. Undefined when nothing stable leads, which
 * makes stream-api fall back to the single-block behaviour.
 */
export function stableSystemPrefixLength(
  sections: readonly RenderedPromptSection[],
): number | undefined {
  let len = 0;
  for (const section of sections) {
    if (section.type !== "static") break;
    if (TURN_VARIANT_STATIC_SECTIONS.has(section.id)) break;
    len += section.text.length;
  }
  return len > 0 ? len : undefined;
}

export interface BuildSystemPromptInput {
  /** Which surface this turn arrived on — drives the channel-context section. */
  channel: ChannelKind;
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
  /** Directive for an explicit build route this turn (/app-build methodology
   *  or a resolved Product Build continuation), from product-build-routing.ts. */
  buildTurnDirective?: string;
}

export async function buildSystemPromptWithTelemetry(
  input: BuildSystemPromptInput,
): Promise<SystemPromptBuildResult> {
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
    const { filterAvailableTools } = await import("../../tools/tool-search.js");
    // Availability gate — the other half of the seam in tool-search.ts. The
    // per-request resolver already withheld unavailable tools from the schema;
    // if the manifest were still built over the RAW catalog every one of them
    // would reappear here by name and the model would be told to tool_search
    // for a capability this machine doesn't have. The prompt nudges go through
    // the same gate for the same reason.
    const availableAgentTools = filterAvailableTools(input.allAgentTools);
    toolPromptSection = buildToolPromptSection(availableAgentTools);
    // Deferred-tool manifest: name every tool NOT loaded into this turn's
    // schema so the model can reach it via tool_search instead of fail-
    // discovering or denying. This is what lets the Anthropic-strong path
    // (tool-selection.ts) ship a filtered set rather than the whole inventory —
    // the schema shrinks, the cold cache-write shrinks, and nothing goes
    // invisible: every tool that can work here is either in the schema or named
    // in the manifest, and no tool the gate hid is ever named. The converse is
    // NOT guaranteed — `input.loadedTools` is selected upstream out of the RAW
    // catalog, so it can still carry an unavailable tool into the schema. That
    // is fail-open and deliberate; see buildDeferredToolManifest's docstring for
    // the full statement of what does and does not hold.
    if (input.loadedTools) {
      toolPromptSection += buildDeferredToolManifest(availableAgentTools, input.loadedTools);
    }
    // A throw anywhere in this block is SILENT and costs discoverability: the
    // manifest is what makes tool_search reachable for every unloaded tool, so
    // swallowing here means the model is shipped a filtered schema with no index
    // of what else exists — the exact invisibility the manifest was added to
    // remove. Left best-effort deliberately (a prompt-assembly throw must not
    // fail the turn), but it is not free, and no assertion downstream can tell
    // the difference between "manifest correctly omitted a tool" and "manifest
    // never emitted". test/integration-seam-contract.test.ts pins the positive
    // side for that reason.
  } catch { /* best-effort */ }

  // No cold-start hint here any more. It was a regex over THIS turn's message
  // ("build/deploy/ship…") that appended a paragraph to the system text on
  // matching turns only — so it toggled in and out across a session and broke
  // the local runtime's prompt cache twice per occurrence, tools and history
  // included (EXP-12, docs/harness/HARNESS_LOG.md). Task-start turns already
  // auto-inject cross-session recall (src/memory/auto-search-context.ts) and
  // the recall-reflex section already names the search tools; the hint was a
  // belt over those suspenders. Removed and measured rather than relocated —
  // if memory-cross-session regresses, the words go in a trailing row.

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

  const { SystemPromptBuilder, createSystemPromptBuilder } =
    await import("../../context/system-prompt-builder.js");
  let contextBuilder: InstanceType<typeof SystemPromptBuilder>;
  if (input.systemPromptOverride) {
    contextBuilder = new SystemPromptBuilder().addSection({
      id: "system-prompt-override",
      label: "System Prompt Override",
      type: "static",
      policy: "required",
      build: () => input.systemPromptOverride!,
    });
  } else {
    // Use full prompt for all providers. The empty-response issue was caused
    // by reasoning: { effort: "low" } in codex-client.ts, not prompt size.
    // The full prompt contains behavioral instructions the agent needs.
    // Prefer hot-reloadable config file over static config object
    const basePrompt = loadSystemPrompt() || input.config.systemPrompt;

    contextBuilder = createSystemPromptBuilder({
      basePrompt,
      providerHint,
      toolPromptSection,
      integrationsContext,
      memoryDir: (input.memoryIndex as unknown as { memoryDir?: string }).memoryDir,
      sessionId: input.sessionId,
      contextBlock: input.contextBlock,
      relevantMemories: input.relevantMemories,
      smartContext: input.smartContext,
      memoryContext: input.memoryContext,
      notificationHint,
      channelContext: channelContextBlock(input.channel),
      bridgeContext: input.bridgeContext,
    });
  }

  for (const [id, label, policy, text] of [
    ["background-completions", "Background Completions", "required", backgroundCompletionsBlock],
    ["short-reply-context", "Short Reply Context", "required", shortReplyContextBlock],
    ["memory-curate", "Memory Curate", "degradable", input.memoryCurateBlock],
    ["file-access", "File Access", "required", fileAccessBlock],
    ["provider-rider", "Provider Rider", "required", providerRider],
    ["model-family-rider", "Model Family Rider", "required", modelFamilyRider],
  ] as const) {
    if (!text) continue;
    contextBuilder.addSection({ id, label, type: "dynamic", policy, build: () => text });
  }

  // Explicit build route only: the background op owns the build and this
  // turn's inline-build tools are stripped (tool-selection.ts); the directive
  // explains why, so the model hands off instead of flailing.
  if (input.buildTurnDirective) {
    const turnDirective = harnessNotice("TURN DIRECTIVE", input.buildTurnDirective);
    contextBuilder.addSection({
      id: "turn-directive",
      label: "Turn Directive",
      type: "dynamic",
      policy: "required",
      build: () => turnDirective,
    });
  }
  const built = await contextBuilder.buildWithTelemetry();
  return built;
}

export async function buildSystemPrompt(input: BuildSystemPromptInput): Promise<string> {
  return (await buildSystemPromptWithTelemetry(input)).prompt;
}

import { join } from "node:path";
import { sanitizeHistory, truncateHistory } from "../providers/sanitize.js";
import { loadSystemPrompt } from "../config-loader.js";
import type { AgentRequestInput, PreparedAgentRequest } from "./types.js";
import { resolveProvider } from "./resolve-provider.js";
import { CORE_TOOL_NAMES, filterToolsForMessage } from "./tool-filter.js";
import { buildTurnContextCached } from "./turn-context-cache.js";

import { createLogger } from "../logger.js";
const logger = createLogger("agent-request.prepare-request");

export async function prepareAgentRequest(input: AgentRequestInput): Promise<PreparedAgentRequest> {
  const {
    channel, message, sessionMessages, sessionId, config, dataDir,
    memoryIndex, memoryManager, integrations, secretsStore, allAgentTools, bridgeTools,
    skipMemory, systemPromptOverride, attachments, uploadsDir,
  } = input;

  // 1. Resolve provider + keys
  // (Long-task routing happens in chat.ts via Fix E — it routes Codex long
  // tasks to the worker pool with a fresh context, NOT to a different
  // provider. Auto-falling-back to Anthropic was the wrong call: it
  // defeated the worker pool's whole purpose, surprised users with
  // unexpected provider switches, and never validated that workers can
  // make Codex perform on long tasks. Workers + fresh context IS the fix.)
  const resolved = await resolveProvider(config, secretsStore, dataDir);
  void logger; // logger kept for future routing diagnostics

  // 2. Sanitize + truncate history. Compaction now lives as a leading
  // `system` message in sessionMessages itself (round-tripped through a
  // `summary` row in the per-session jsonl log on disk). No special-case
  // slice/prepend logic needed here — the session passed in is already
  // the right shape, with `[system_summary, ...recent_msgs]` when
  // compacted and just `[...msgs]` otherwise.
  const maxKeep = input.maxHistory || (channel === "web" ? 40 : 30);
  const cleanHistory = truncateHistory(sanitizeHistory(sessionMessages), maxKeep);

  // 3. Build context (skip heavy parts for bridges/cron). The memory pipeline
  // runs for every provider — the orchestrator's grounding signals help Codex
  // the same way they help Claude. Daily log stays skipped for Codex to keep
  // OpenAI content-moderation from tripping on replayed verbatim user messages.
  const isTrivialToolRequest = /^(run\s+(bash|command)|execute|bash)\s*(with|:)/i.test(message.trim()) ||
    /^(ls|dir|cat|echo|Write-Output|Get-ChildItem|pwd|whoami|git\s)/i.test(message.trim());
  const isCodexProvider = resolved.provider === "codex";

  // v3.2: image-aware recall-reflex (revised). Earlier draft tried a
  // separate vision pre-extract call before the main turn, but that
  // assumed plain API keys (OPENAI_API_KEY / sk-ant-api03-*) most users
  // don't have — Codex/Claude subscription auth routes through CLIs that
  // either don't expose vision or strip images. Instead: the main agent
  // already has vision (gpt-5.5, Sonnet, etc.). Just flag for the system-
  // prompt nudge that an image is attached so the agent's reflex extends
  // to image-extracted entities, not only typed-text entities.
  let recallScanText = message;
  if (attachments && attachments.some((a) => a.isImage)) {
    // Tag the recall-scan input so downstream code (orchestrator,
    // known-projects scan) knows to be conservative about typed-text
    // matches and the system-prompt reflex knows an image is present.
    recallScanText = `${message}\n[user attached an image — reflex: identify any brand/project/domain you can read from it, then call search_past_sessions on that name before answering]`;
  }

  const turnCtx = await buildTurnContextCached(memoryManager, {
    userMessage: recallScanText,
    sessionId,
    sessionMessages: sessionMessages.slice(-20).map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
    })),
    skipDailyLog: isCodexProvider,
    liteMode: !skipMemory && isTrivialToolRequest,
    minimalMode: skipMemory,
  });
  let contextBlock = turnCtx.contextBlock;
  let relevantMemories = turnCtx.relevantMemories;
  let smartContext = turnCtx.smartContext;
  let memoryContext = turnCtx.memoryContext;
  const memoryNotifications = turnCtx.notifications;
  if (isTrivialToolRequest && !skipMemory) logger.info(`[chat] Trivial tool request — skipping memory injection`);
  else if (isCodexProvider && !skipMemory) logger.info(`[chat] Codex provider — daily log skipped`);

  // For Codex (128k context), cap the memory context block. The full
  // core_memory dump can be 5,000+ tokens of retained facts — essential
  // for 200k+ models but overkill for casual chat on a tight budget.
  // Keep identity + profile + today context, trim core_memory to first 2k chars.
  if (isCodexProvider && contextBlock.length > 3000) {
    contextBlock = contextBlock.replace(
      /<core_memory>([\s\S]*?)<\/core_memory>/,
      (_, content: string) => `<core_memory>\n${content.slice(0, 2000)}\n[...truncated for context budget]\n</core_memory>`
    );
  }

  // 4. Build system prompt
  const providerNames: Record<string, string> = {
    codex: "OpenAI Codex", anthropic: "Anthropic Claude", xai: "xAI Grok",
    openai: "OpenAI", local: "Local (Ollama)", gemini: "Google Gemini",
  };
  const providerHint = `\n\n[System: You are currently powered by ${providerNames[resolved.provider] || resolved.provider}, model: ${resolved.model}.]`;
  const integrationsContext = integrations.getAgentContext();

  let notificationHint = "";
  if (memoryNotifications.length > 0) {
    const topNotifs = memoryNotifications.sort((a, b) => b.priority - a.priority).slice(0, 2);
    notificationHint = "\n\n[Naturally weave into your response: " + topNotifs.map(n => n.message).join(" | ") + "]";
  }

  // Tool selection (moved up from §5): we need the FINAL filtered tool list
  // BEFORE building toolPromptSection so the per-tool usage hints only cover
  // tools the model can actually call this turn. Earlier the section was built
  // over allAgentTools (74 entries), but the API only ships filtered tools —
  // ~50-70% of the toolPromptSection bytes were nudges for tools that weren't
  // even in the call set, just consuming input tokens.
  const isBridge = channel === "telegram" || channel === "whatsapp";
  let tools = isBridge ? bridgeTools : filterToolsForMessage(allAgentTools, message);

  // Shrink for weaker models. 100+ tool catalogs paralyze Grok / small local
  // models (0-token responses). Cap aggressively while keeping essentials
  // ordered first.
  const { classifyModel, shrinkToolsForTier } = await import("../model-tiers.js");
  const tier = classifyModel(resolved.model);
  if (tier !== "strong") {
    const before = tools.length;
    tools = shrinkToolsForTier(tools, tier, allAgentTools);
    if (tools.length !== before) {
      logger.info(`[tools] Shrunk ${before}→${tools.length} for ${tier} model ${resolved.model} (${tools.map(t=>t.name).join(",")})`);
    }
  }

  // Weak-model context strip. Small local models (qwen2:7b, llama3:8b,
  // qwen2.5:7b) cannot reliably separate "third-person facts about the
  // user" from "instructions for what voice to write in" — the bulky
  // user-profile + core_memory + RAG-hit context blocks trigger them to
  // collapse into the user's first-person voice and produce a fake
  // nightly-update-as-Peter response. The Voice Guard in the base
  // prompt helps, but the cleaner fix on weak models is to not put
  // most of that context in front of them in the first place. Strong
  // models (Sonnet/Opus, gpt-5-class) keep the full context — they
  // parse it as third-person info correctly.
  if (tier === "weak") {
    contextBlock = "";
    relevantMemories = "";
    smartContext = "";
    memoryContext = "";
    logger.info(`[chat] weak tier ${resolved.model} — stripped memory/profile context to prevent roleplay drift`);
  }
  if (!isBridge) {
    try {
      const { getToolRAG } = await import("../tool-rag.js");
      const rag = getToolRAG();
      // IMPORTANT: do NOT call rag.build() from the chat path. Building
      // requires embedding all 167 tools serially on Ollama; on CPU-only
      // boxes that's 50-100s. The pre-warm at server boot
      // (src/server/index.ts) is the ONLY caller that builds. If a chat
      // arrives before pre-warm finishes, we just don't filter tools this
      // turn — the chat ships with the full tool list (after the model-
      // tier shrink above) and RAG kicks in on later turns once warm.
      // Logged once per cold-start chat to surface the rare "first chat
      // beat the pre-warm" case for telemetry.
      if (rag.isReady) {
        const semantic = await rag.select(message, allAgentTools, {
          topK: 22,
          minScore: 0.25,
          corePinned: [...CORE_TOOL_NAMES],
          includeMCP: true,
        });
        const union = new Set(tools.map(t => t.name));
        for (const t of semantic) union.add(t.name);
        tools = allAgentTools.filter(t => union.has(t.name));
      } else {
        logger.info(`[tool-rag] not ready yet — shipping all tools this turn (pre-warm in flight)`);
      }
    } catch (e) {
      logger.warn(`[tool-rag] Skipped: ${(e as Error).message}`);
    }
  }

  let toolPromptSection = "";
  // Per-tool usage guidance. Built over allAgentTools (NOT the filtered
  // `tools`) because the keyword/RAG filters sometimes drop a tool's
  // behavioral nudge while still including the tool in the API call —
  // model sees the tool but loses the "USE PROACTIVELY" encouragement.
  // Live regression: chat where browser was needed but didn't fire,
  // because the message had no obvious browser keyword. Spending the
  // ~3-5KB on the full nudge set is cheaper than missed tool calls.
  // Codex used to skip this entirely "to save tokens" but live testing
  // (transformforfitness deploy, 2026-05-01) showed Codex stalled on a
  // cold-start ship task without the proactive memory_search nudge.
  try {
    const { buildToolPromptSection } = await import("../tool-prompt-builder.js");
    toolPromptSection = buildToolPromptSection(allAgentTools);
  } catch {}

  // Cold-start nudge — applies to BOTH providers, but disproportionately
  // helps Codex which doesn't auto-call memory_search the way Anthropic does
  // when the user kicks off a project that might have prior context. Scoped
  // to ship/build/deploy class messages so we don't burn tokens nudging the
  // agent on simple chats.
  const COLD_START_VERBS = /\b(build|create|make|deploy|publish|launch|set\s+up|put\s+\S+\s+(live|online)|ship|generate|scaffold|spin\s+up)\b/i;
  let coldStartHint = "";
  if (COLD_START_VERBS.test(message)) {
    coldStartHint = "\n\n[COLD-START HINT] This message looks like the start of a project/deploy/build task. BEFORE writing code, run memory_search on the project name, domain, or business name in case there's prior context (URLs, prior decisions, brand assets, user preferences) from earlier sessions. Cold-starting without checking memory first is a real failure mode — the agent reinvents stuff that was already discussed and ships thinner output. 1-2 memory_search calls = cheap; missing context = expensive iteration.";
  }
  toolPromptSection += coldStartHint;

  // Drain pending background-op completions for this session so the agent
  // can narrate them naturally on this turn (per the agent-narrates pattern
  // — see workers/pending-notifications.ts for rationale).
  let backgroundCompletionsBlock = "";
  try {
    const { drainPendingNotifications, formatNotificationsForSystemPrompt } = await import("../workers/pending-notifications.js");
    const { cancelIdleNudge, markSessionExplicitNotify, recordSessionLastMessage } = await import("../workers/idle-nudge.js");
    cancelIdleNudge(sessionId);
    markSessionExplicitNotify(sessionId, message);
    recordSessionLastMessage(sessionId, message);
    const pending = drainPendingNotifications(sessionId);
    if (pending.length > 0) {
      backgroundCompletionsBlock = formatNotificationsForSystemPrompt(pending);
      logger.info(`[chat] injecting ${pending.length} background completion(s) into system prompt for sess=${sessionId}`);
    }
  } catch { /* best-effort */ }

  // Short-reply context reminder: when the user's message is short AND the
  // previous assistant turn ended with a question/offer, the model often
  // takes the short reply LITERALLY as a fresh standalone instruction
  // instead of as an answer to its prior question. Live failure: agent
  // asked "Want a diff or browser spot-check?" → user said "open the
  // browser" → agent opened browser to google.com instead of the kraken
  // app it had just been talking about. Inject a context reminder so the
  // model re-reads its prior turn before deciding what to do.
  // Memory-curate nudge — fires opportunistically (correction/preference
  // signals) and on cadence (every N turns). Replaces the older
  // CorrectionLearner verbatim-injection: instead of telling the model "you
  // were corrected on X, the answer was Y," we give the model a tool surface
  // it already has (memory_update_profile) and pressure to use it. The model
  // decides what's worth saving and how to phrase it generally — that's the
  // architectural shift from rule-curated to model-curated memory.
  //
  // Boost detection runs in two stages:
  //   1. Cheap regex/CorrectionLearner — catches obvious phrasings ("always",
  //      "never", "I prefer", explicit "no/wrong" corrections). If any of
  //      these match, we boost immediately and skip the LLM call.
  //   2. LLM classifier (Haiku 4.5, ~$0.0004/call, 2s timeout) — catches
  //      natural-language teaching moments the regex misses ("you need to
  //      toggle to instagram view", "switch to the other dropdown", etc.).
  //      Only runs when regex didn't fire. On any failure (no auth, timeout,
  //      bad JSON) we silently fall back to "no boost from classifier" and
  //      let the cadence-based fire catch it eventually.
  let memoryCurateBlock = "";
  try {
    const { checkAndConsumeNudge, boostNudgePriority } = await import("../memory/curate-nudge.js");
    let regexBoosted = false;
    // Stage 1 — CorrectionLearner regex (still used as a signal source even
    // though its verbatim output no longer gets injected into prompts).
    const lastAssistantMsg = [...sessionMessages].reverse().find(m => m.role === "assistant");
    const lastAssistantText = typeof lastAssistantMsg?.content === "string" ? lastAssistantMsg.content : "";
    try {
      const { CorrectionLearner } = await import("../correction-learning.js");
      if (lastAssistantText) {
        const correction = CorrectionLearner.getInstance().detectCorrection(message, lastAssistantText);
        if (correction) { boostNudgePriority(sessionId, "correction-detected"); regexBoosted = true; }
      }
    } catch { /* detector unavailable — fine */ }
    // Stage 1 cont. — preference-phrase regex
    if (/\b(always|never|next time|from now on|i prefer|i like to|i usually|please remember|don['']?t forget|going forward|in the future)\b/i.test(message)) {
      boostNudgePriority(sessionId, "preference-stated");
      regexBoosted = true;
    }
    if (/\b(remember (this|that)|save this|note this|keep in mind that)\b/i.test(message)) {
      boostNudgePriority(sessionId, "explicit-remember");
      regexBoosted = true;
    }
    // Stage 2 — LLM classifier as second-opinion when regex missed. Run
    // in the background AT LOW PRIORITY so we don't block the user turn:
    // we await with a short overall budget; if the classifier is slow,
    // we skip the boost and let cadence catch it next time. The boost
    // (if it lands in time) still affects THIS turn's nudge check.
    if (!regexBoosted) {
      try {
        const { classifyTeachMoment } = await import("../memory/curate-classifier.js");
        // Use the SAME provider+model+apiKey the chat is on — the classifier
        // calls the same client functions the main agent uses, so CLI OAuth
        // (Anthropic) and subscription bearer (Codex) auth "just work" with
        // no per-provider auth abstraction needed. Cost-bounded by the tiny
        // ~30-token output and 2s timeout. xAI/Gemini fall through to null
        // (regex+cadence still work for those providers).
        const classification = await classifyTeachMoment(message, lastAssistantText, {
          providerHint: resolved.provider,
          modelHint: resolved.model,
          apiKey: resolved.apiKey,
        });
        if (classification && classification.teach && classification.confidence >= 0.6 && classification.kind !== "none") {
          boostNudgePriority(sessionId, classification.kind);
          logger.info(`[chat] curate-classifier boosted ${classification.kind} (conf=${classification.confidence.toFixed(2)}, why=${classification.why}, provider=${resolved.provider}) sess=${sessionId}`);
        }
      } catch { /* classifier unavailable — fall back to cadence */ }
    }
    // In-prompt nudge is DISABLED — it competed with task completion in
    // the live model's attention and produced regressions (turn ending
    // with neither a useful answer NOR a memory write). Memory writes
    // now happen via the end-of-turn pass in routes/chat.ts which runs
    // AFTER the user has already received the assistant's reply, with
    // no attention split.
    //
    // The classifier + boost calls above still run because:
    //   (a) the boost log lines are useful diagnostic signal during
    //       calibration ("did the classifier even fire on this turn?")
    //   (b) the per-session counter is read by the end-of-turn pass to
    //       decide whether to invoke its (cheaper) decision call
    //
    // To re-enable in-prompt nudges (e.g. for A/B comparison), set
    // env LAX_MEMORY_INPROMPT_NUDGE=1.
    if (process.env.LAX_MEMORY_INPROMPT_NUDGE === "1") {
      const nudge = checkAndConsumeNudge(sessionId);
      if (nudge) {
        memoryCurateBlock = `\n\n${nudge}\n`;
        logger.info(`[chat] injecting memory-curate nudge for sess=${sessionId}`);
      }
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

  // Codex-specific behavioral rider. Vague tone-shift instructions ("be a
  // senior dev") barely move Codex; concrete IF-THEN behavioral rules tied
  // to actual failure modes do. The pattern that triggered this: user asked
  // Codex to "open chatgpt.com and generate an image"; Codex ground through
  // ~10 read-only tool calls trying to figure out the login state instead
  // of stopping to tell the user it needed them to sign in. Anthropic on the
  // same prompt warned about typing passwords on a public network and asked
  // the user to log in. Same prompt — different willingness-to-stop-and-ask.
  let codexBehaviorRider = "";
  if (isCodexProvider) {
    codexBehaviorRider =
      `\n\n[CODEX BEHAVIOR RIDER — concrete rules, follow strictly]\n` +
      `1. **STRUCTURAL AUTH-WALL = STOP**. Only when a tool result starts with "[AUTH-WALL DETECTED]" — that's the structural signal that the page has a PRIMARY login form blocking your task. On that signal: STOP, tell the user what to log into in one sentence, add a brief safety reminder if relevant ("double-check the URL is the real site"). Do NOT call more snapshot/extract tools to "make sure" — the structural detector already confirmed it. Without that marker, treat password fields as INCIDENTAL (signup link in nav, footer login, etc.) and continue your task. Earlier version of this rule fired on ANY password field — caused the agent to give up on tasks like "open grok.com and do X" because a hidden signup form was misread as a blocker.\n` +
      `2. **NEVER TYPE PASSWORDS YOURSELF**. Even if a password field is empty and you "could" fill it, you must not. The user enters credentials in the browser themselves. If you need a stored secret for an API call, use request_secret — never paste secret values into a browser form.\n` +
      `3. **READ-THEN-ACT DISCIPLINE**. After ~5 read-only tool calls (read/glob/grep/snapshot/extract/observe/web_fetch) WITHOUT making concrete progress (a write/edit/click/bash that did something useful, or learning a fact that meaningfully changed your plan), STOP. Either commit to an action or ask the user ONE focused question. Repeated reads of the same file or repeated snapshots of the same page count as zero progress. Earlier version was 3 calls — softened because some legitimate investigations need more reads.\n` +
      `4. **DON'T PRETEND TO HAVE CAPABILITIES YOU LACK**. If a task needs something you can't do (uploading a file via a web UI element, taking a phone call, paying for something, accepting Terms on the user's behalf), say so plainly and ask the user to do that step.\n` +
      `5. **SECURITY-CAUTIOUS BY DEFAULT**. When the task involves credentials, payments, or anything irreversible, surface the risk briefly before acting ("about to click Pay $X — confirm?") rather than just doing it.\n`;
  }

  let systemPrompt: string;
  if (systemPromptOverride) {
    // Sub-agents provide their own prompt
    systemPrompt = systemPromptOverride + backgroundCompletionsBlock + shortReplyContextBlock + memoryCurateBlock + codexBehaviorRider;
  } else {
    // Use full prompt for all providers. The empty-response issue was caused
    // by reasoning: { effort: "low" } in codex-client.ts, not prompt size.
    // The full prompt contains behavioral instructions the agent needs.
    // Prefer hot-reloadable config file over static config object
    const basePrompt = loadSystemPrompt() || config.systemPrompt;

    const { createSystemPromptBuilder } = await import("../context-builder.js");
    const contextBuilder = createSystemPromptBuilder({
      basePrompt,
      providerHint,
      toolPromptSection,
      integrationsContext,
      memoryDir: (memoryIndex as unknown as { memoryDir?: string }).memoryDir,
      contextBlock,
      relevantMemories,
      smartContext,
      memoryContext,
      notificationHint,
      bridgeContext: input.bridgeContext,
    });
    systemPrompt = (await contextBuilder.build()) + backgroundCompletionsBlock + shortReplyContextBlock + memoryCurateBlock + codexBehaviorRider;
  }

  // §5 (tool selection) moved up so toolPromptSection could be built over
  // the filtered set. `tools`, `isBridge`, tier-shrink and RAG rerank all
  // already ran before this point.

  // 6. Process image attachments
  const images: Array<{ url: string; filePath?: string; name: string }> = [];
  if (attachments && uploadsDir) {
    for (const a of attachments) {
      if (a.isImage && a.url) {
        const fname = a.url.replace(/^\/uploads\//, "");
        images.push({ name: a.name, url: a.url, filePath: join(uploadsDir, fname) });
      }
    }
  }

  return {
    provider: resolved.provider,
    apiKey: resolved.apiKey,
    model: resolved.model,
    codexApiKey: resolved.codexApiKey,
    customBaseURL: resolved.customBaseURL,
    systemPrompt,
    tools,
    cleanHistory,
    images,
    temperature: resolved.temperature,
    maxIterations: resolved.maxIterations,
  };
}

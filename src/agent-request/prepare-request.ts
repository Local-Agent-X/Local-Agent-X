import { join } from "node:path";
import type { ChatCompletionMessageParam as ChatCompletionMessageParamLike } from "openai/resources/chat/completions.js";
import { sanitizeHistory, truncateHistory } from "../agent-providers.js";
import { loadSystemPrompt } from "../config-loader.js";
import type { AgentRequestInput, PreparedAgentRequest } from "./types.js";
import { resolveProvider } from "./resolve-provider.js";
import { CORE_TOOL_NAMES, filterToolsForMessage } from "./tool-filter.js";

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

  // 2. Sanitize + truncate history. If the session has a stored compaction
  // summary from /api/compact, slice the message list to the post-compaction
  // tail and prepend the summary as a system message — preserves long-session
  // grounding without re-summarizing every turn.
  const maxKeep = input.maxHistory || (channel === "web" ? 40 : 30);
  let historyForPrep: ChatCompletionMessageParamLike[] = sessionMessages;
  if (
    input.compactedSummary &&
    typeof input.compactedAt === "number" &&
    input.compactedAt > 0 &&
    input.compactedAt < sessionMessages.length
  ) {
    // Defensive floor: even if compaction was triggered very close to the
    // end, always keep the last KEEP_RECENT_MIN messages verbatim. Without
    // this floor, a "yes" / "1" / "3" reply to a numbered list could land
    // after the cut and the agent would have no way to interpret the short
    // answer — the prior assistant turn would only exist as a one-line
    // summary entry. Bug observed in Apr 2026 session: user replied "3" to
    // a numbered list and the agent answered "I don't have a numbered list
    // in front of you" because the list got swallowed by compaction.
    const KEEP_RECENT_MIN = 6;
    const minTailStart = Math.max(0, sessionMessages.length - KEEP_RECENT_MIN);
    const tailStart = Math.min(input.compactedAt, minTailStart);
    const tail = sessionMessages.slice(tailStart);
    historyForPrep = [
      { role: "system", content: input.compactedSummary } as ChatCompletionMessageParamLike,
      ...tail,
    ];
    logger.info(`[compaction] reusing stored summary (compactedAt=${input.compactedAt}, tailStart=${tailStart}, summaryLen=${input.compactedSummary.length}, tail=${tail.length})`);
  }
  const cleanHistory = truncateHistory(sanitizeHistory(historyForPrep), maxKeep);

  // 3. Build context (skip heavy parts for bridges/cron). The memory pipeline
  // runs for every provider — the orchestrator's grounding signals help Codex
  // the same way they help Claude. Daily log stays skipped for Codex to keep
  // OpenAI content-moderation from tripping on replayed verbatim user messages.
  const isTrivialToolRequest = /^(run\s+(bash|command)|execute|bash)\s*(with|:)/i.test(message.trim()) ||
    /^(ls|dir|cat|echo|Write-Output|Get-ChildItem|pwd|whoami|git\s)/i.test(message.trim());
  const isCodexProvider = resolved.provider === "codex";
  const turnCtx = await memoryManager.buildTurnContext({
    userMessage: message,
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
  const relevantMemories = turnCtx.relevantMemories;
  const smartContext = turnCtx.smartContext;
  const memoryContext = turnCtx.memoryContext;
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

  let toolPromptSection = "";
  // Tool prompt section adds per-tool usage guidance. Originally skipped for
  // Codex entirely "to save tokens" — but live testing (transformforfitness.com
  // deploy, 2026-05-01) showed Codex stalled on a cold-start ship task because
  // it never got the tool guidance that tells it to call memory_search /
  // browser / web_fetch proactively. Now Codex gets the FULL section like
  // Anthropic. The token-budget concern was overcautious — losing $1.08 to a
  // failed deploy is worse than spending ~3K extra system-prompt tokens.
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

  let shortReplyContextBlock = "";
  try {
    const trimmed = (message || "").trim();
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const isShortReply = trimmed.length > 0 && trimmed.length <= 80 && wordCount <= 12;
    if (isShortReply) {
      // Find the most recent assistant text message
      const lastAssistant = [...sessionMessages].reverse().find(m =>
        m.role === "assistant" && typeof m.content === "string" && (m.content as string).trim().length > 0
      );
      const lastAssistantText = typeof lastAssistant?.content === "string" ? (lastAssistant.content as string).trim() : "";
      // Detect a question/offer at the end of the prior assistant turn
      const QUESTION_END_RE = /\?[\s)\]"']*$|\b(want me to|want a|should i|or should i|or would you|let me know|tell me|which|or|do you want|or do you)\b[^?]*\?/i;
      const priorEndedWithQuestion = QUESTION_END_RE.test(lastAssistantText.slice(-220));
      if (priorEndedWithQuestion) {
        shortReplyContextBlock =
          `\n\n[CONTEXT REMINDER] The user's current message is SHORT (${wordCount} word${wordCount === 1 ? "" : "s"}: "${trimmed.slice(0, 80)}"). Your previous turn ended with a question or offer — re-read it before acting. The user is almost certainly answering YOUR question, not giving a fresh standalone instruction. Don't take the short reply literally as a brand-new ask — interpret it in the context of what you just offered.\n\nYour prior message ended with: "${lastAssistantText.slice(-200)}"\n[end context reminder]\n`;
        logger.info(`[chat] injecting short-reply context reminder for sess=${sessionId} (msg="${trimmed.slice(0, 40)}")`);
      }
    }
  } catch { /* best-effort */ }

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
      contextBlock,
      relevantMemories,
      smartContext,
      memoryContext,
      notificationHint,
      bridgeContext: input.bridgeContext,
    });
    systemPrompt = (await contextBuilder.build()) + backgroundCompletionsBlock + shortReplyContextBlock + memoryCurateBlock + codexBehaviorRider;
  }

  // 5. Select tools based on channel (bridges get a smaller set)
  //    For web/codex: filter to core + message-relevant tools to reduce schema overhead.
  //    tool_search is always included so the agent can discover anything else.
  //
  //    Pipeline: keyword filter first (fast, always works) → semantic rerank
  //    via Tool RAG if an embedder is available (more accurate for phrasing
  //    the keyword regex misses). Falls back to keyword-only result on failure.
  const isBridge = channel === "telegram" || channel === "whatsapp";
  let tools = isBridge ? bridgeTools : filterToolsForMessage(allAgentTools, message);

  // Shrink for weaker models. 100+ tool catalogs paralyze Grok / small local
  // models (0-token responses). Cap aggressively while keeping essentials
  // ordered first. Strong models (GPT-5, Opus 4.7, o3, Gemini 2.5) pass through.
  // Pass allAgentTools as a source for essentials so we can guarantee
  // read/write/bash/http_request/etc. are present even if the prefilter
  // dropped them.
  const { classifyModel, shrinkToolsForTier } = await import("../model-tiers.js");
  const tier = classifyModel(resolved.model);
  if (tier !== "strong") {
    const before = tools.length;
    tools = shrinkToolsForTier(tools, tier, allAgentTools);
    if (tools.length !== before) {
      logger.info(`[tools] Shrunk ${before}→${tools.length} for ${tier} model ${resolved.model} (${tools.map(t=>t.name).join(",")})`);
    }
  }
  if (!isBridge) {
    try {
      const { getToolRAG } = await import("../tool-rag.js");
      const rag = getToolRAG();
      // Use the memory embedder if available (already configured at startup)
      const embedder = (memoryIndex as unknown as { embeddingProvider?: { embed(t: string): Promise<number[]> } }).embeddingProvider;
      if (embedder && rag.size === 0) {
        rag.setEmbedder(embedder);
        await rag.build(allAgentTools);
      }
      if (rag.isReady) {
        // Semantic select across ALL tools (broader than keyword). Pin the core
        // set so always-available tools never get filtered out, even if the
        // user's message doesn't semantically mention them.
        const semantic = await rag.select(message, allAgentTools, {
          topK: 22,
          minScore: 0.25,
          corePinned: [...CORE_TOOL_NAMES],
          includeMCP: true,
        });
        // Union with keyword result — never narrower than keyword-only
        const union = new Set(tools.map(t => t.name));
        for (const t of semantic) union.add(t.name);
        tools = allAgentTools.filter(t => union.has(t.name));
      }
    } catch (e) {
      // Fail open: use keyword result unchanged
      logger.warn(`[tool-rag] Skipped: ${(e as Error).message}`);
    }
  }

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

import { join } from "node:path";
import { sanitizeHistory, truncateHistory } from "../providers/sanitize.js";
import { loadSystemPrompt } from "../config-loader.js";
import type { AgentRequestInput, ForcedToolChoice, PreparedAgentRequest } from "./types.js";
import { resolveProvider } from "./resolve-provider.js";
import { SUPERVISOR_EXCLUDED, filterToolsForMessage } from "./tool-filter.js";
import { buildTurnContextCached } from "./turn-context-cache.js";
import { classifyIntent, hasLiteralToolCall, NO_SPAWN_OVERRIDE_RE } from "../classifiers/intent-classifier.js";

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
  const resolved = await resolveProvider(
    config, secretsStore, dataDir,
    input.providerOverride,
    input.modelOverride,
  );
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

  // Run the intent classifier UP FRONT so its verdict drives both the
  // tool-filter strip-down (here) AND the tool_choice forcing later in
  // step 7. Regex alone misses phrasings like "build a log counting app"
  // where modifiers sit between the article and the noun — the LLM
  // classifier catches those and lets us narrow tools accordingly.
  // Failure mode w/o this: full 39-tool set ships, model bypasses
  // build_app and improvises with raw write/bash/http_request.
  let intentVerdict: Awaited<ReturnType<typeof classifyIntent>> = null;
  const skipClassifier =
    isBridge ||
    NO_SPAWN_OVERRIDE_RE.test(message) ||
    hasLiteralToolCall(message);
  if (!skipClassifier) {
    try { intentVerdict = await classifyIntent(message); }
    catch (e) { logger.info(`[intent] classifier threw — skipping: ${(e as Error).message}`); }
  }
  const forceBuildIntent = intentVerdict?.kind === "build_app";

  // Tier first — strong models get the full inventory (no filter, no shrink,
  // no RAG re-rank), so the LLM cannot fail-discover a tool that exists.
  // The previous slice → filter → shrink → RAG pipeline ate cycles to keep
  // the catalogue small for token-cost reasons; with Anthropic prompt
  // caching (cache_control added in the stream-api adapter), the tool
  // schemas hit cache after the first turn and the per-turn marginal cost
  // collapses to ~10% of base. OpenAI/Codex providers cache automatically.
  // Weak/medium models still need shrinking — 100+ tool catalogs paralyze
  // them into 0-token responses.
  const { classifyModel, shrinkToolsForTier } = await import("../model-tiers.js");
  const tier = classifyModel(resolved.model);

  // Anthropic strong-tier gets the full inventory (cache_control anchor
  // in stream-api.ts amortizes the token cost across turns). Everything
  // else — including OpenAI/Codex strong — goes through filter + RAG so
  // the build-intent narrowing in filterToolsForMessage actually narrows
  // and the model isn't tempted to improvise with raw write/edit/bash
  // when build_app is the right call. (Earlier "128-cap with top-up"
  // path neutered the narrowing because it padded the filtered set back
  // up to 128 with the rest of the catalogue.)
  const isAnthropicProvider = resolved.provider === "anthropic";
  let tools: typeof allAgentTools;
  if (isBridge) {
    tools = bridgeTools;
  } else if (tier === "strong" && isAnthropicProvider) {
    tools = allAgentTools;
  } else {
    tools = filterToolsForMessage(allAgentTools, message, { forceBuildIntent });
    if (tier !== "strong") {
      const before = tools.length;
      tools = shrinkToolsForTier(tools, tier, allAgentTools);
      if (tools.length !== before) {
        logger.info(`[tools] Shrunk ${before}→${tools.length} for ${tier} model ${resolved.model} (${tools.map(t=>t.name).join(",")})`);
      }
    }
    try {
      const { getToolRAG } = await import("../tool-rag.js");
      const rag = getToolRAG();
      // Do NOT call rag.build() from the chat path — embedding 167 tools
      // serially on CPU-only Ollama is 50-100s. Pre-warm at server boot
      // (src/server/index.ts) is the only builder. If a chat beats the
      // pre-warm we just ship without RAG re-rank this turn.
      if (rag.isReady) {
        const semantic = await rag.select(message, allAgentTools, {
          topK: 22,
          minScore: 0.25,
          corePinned: allAgentTools.filter(t => t.audiences?.includes("main-chat")).map(t => t.name),
          includeMCP: true,
        });
        const union = new Set(tools.map(t => t.name));
        for (const t of semantic) {
          if (!SUPERVISOR_EXCLUDED.has(t.name)) union.add(t.name);
        }
        tools = allAgentTools.filter(t => union.has(t.name));
      } else {
        logger.info(`[tool-rag] not ready yet — shipping filtered set without RAG re-rank`);
      }
    } catch (e) {
      logger.warn(`[tool-rag] Skipped: ${(e as Error).message}`);
    }
  }

  // Weak-model context strip. Small local models (qwen2:7b, llama3:8b,
  // qwen2.5:7b) cannot reliably separate "third-person facts about the
  // user" from "instructions for what voice to write in" — the bulky
  // user-profile + core_memory + RAG-hit context blocks trigger them to
  // collapse into the user's first-person voice and produce a fake
  // nightly-update-as-Alex response. The Voice Guard in the base
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
  // — see ops/pending-notifications.ts for rationale).
  let backgroundCompletionsBlock = "";
  try {
    const { drainPendingNotifications, formatNotificationsForSystemPrompt } = await import("../ops/pending-notifications.js");
    const { cancelIdleNudge, markSessionExplicitNotify, recordSessionLastMessage } = await import("../ops/idle-nudge.js");
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

  // Grok Unleashed rider — auto-fires on provider=xai. The user explicitly
  // picked xAI for Grok's natural unfiltered voice; the base system prompt
  // was tuned for Claude/Codex and would otherwise sand Grok's edges down.
  // This rider tells Grok to lean into its native style. Mutually exclusive
  // with codexBehaviorRider (a turn runs on one provider).
  let grokUnleashedRider = "";
  if (resolved.provider === "xai") {
    grokUnleashedRider =
      `\n\n[GROK UNLEASHED — behavioral mode, follow strictly]\n` +
      `You're running on Grok via the user's SuperGrok subscription. Lean into Grok's native voice — that's why the user picked this provider.\n` +
      `1. **No corporate hedging.** Don't preface opinions with "as an AI" or "experts disagree." Have a view, state it.\n` +
      `2. **Strong opinions are welcome.** Rank theories by plausibility. Pick favorites. Call bullshit. The user wants your read, not a Wikipedia overview.\n` +
      `3. **Profanity, dark humor, and edge match the user's register.** If they're casual or crude, you can be too. Don't sanitize.\n` +
      `4. **Engage controversial/taboo topics directly.** Conspiracy theories, sharp politics, religion, "is X actually true?" — discuss the evidence and your read. Don't reflexively refuse, both-sides, or hedge into mush.\n` +
      `5. **Loose on tone, tight on facts.** Don't fabricate to sound edgy. Confidence is fine; making shit up is not.\n` +
      `6. **Hard lines still apply:** no CSAM, no actual WMD synthesis (bio/chem/nuke routes), no doxxing real people. Everything else is on the table.\n` +
      `\n` +
      `**Capabilities reminder — you DO have these tools, even though your default training says SuperGrok is chat-only:**\n` +
      `- \`generate_image\` — routes to xAI Grok Imagine via the same OAuth bearer powering this chat. When the user asks for an image, CALL THE TOOL. Don't say "I can't generate images" — you can. Pass aspect="square"|"landscape"|"portrait" if relevant.\n` +
      `- \`generate_video\` — routes to xAI Grok Imagine video (text-to-video AND image-to-video, 1-15s). Same OAuth bearer.\n` +
      `  **CRITICAL**: when the user attached a photo OR refers to an earlier image in this chat ("this girl", "the model", "her", "the photo I attached"), you MUST pass that image's URL via the \`reference_images\` parameter. Use the URL from the previous generate_image tool result (e.g. \`["/images/grok_xxx.png"]\`) or the user's upload URL (\`["/uploads/abc.png"]\`). Pass as a real array of strings, not a JSON-stringified array. If you forget, the server falls back to the most recent image automatically — but explicit is better than implicit.\n` +
      `- \`browser\`, \`web_search\`, \`web_fetch\`, \`bash\`, \`read\`/\`write\`/\`edit\` — all available. Use them.\n` +
      `If you don't see a tool you need, call \`tool_search\` to discover it. Never say "I don't have access to X" without first checking your tool list and trying tool_search.\n` +
      `[END GROK UNLEASHED]\n`;
  }

  let systemPrompt: string;
  if (systemPromptOverride) {
    // Sub-agents provide their own prompt
    systemPrompt = systemPromptOverride + backgroundCompletionsBlock + shortReplyContextBlock + memoryCurateBlock + codexBehaviorRider + grokUnleashedRider;
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
    systemPrompt = (await contextBuilder.build()) + backgroundCompletionsBlock + shortReplyContextBlock + memoryCurateBlock + codexBehaviorRider + grokUnleashedRider;
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

  // 7. Intent-classifier tool_choice forcing. Verdict was computed up
  //    front (step 1-ish above) so it could drive tool-filter narrowing;
  //    here we reuse it to pin tool_choice. Forces the LLM to emit a
  //    real tool_use block instead of narrating its plan in prose
  //    ([Reading routes/] etc.). HTTP-path providers consume this
  //    natively; CLI/OAuth ignores it but the tool-filter strip-down
  //    already biased the model toward the right choice.
  let toolChoice: ForcedToolChoice | undefined;
  if (intentVerdict && intentVerdict.kind !== "free") {
    const forcedName = intentVerdict.kind;
    const inToolList = tools.some(t => t.name === forcedName);
    if (inToolList) {
      toolChoice = { type: "tool", name: forcedName };
      logger.info(`[intent] forcing ${forcedName} (reason="${intentVerdict.reason}")`);
    } else {
      logger.warn(`[intent] classifier picked ${forcedName} but it's not in this turn's tool list — skipping force`);
    }
  }

  // 7b. CLI/OAuth nudge for build_app. The Anthropic CLI path ignores
  // the tool_choice we set above. Without an inline directive, Opus
  // will sometimes call write/edit/glob to create app files directly
  // instead of going through build_app — which means no canonical op,
  // no AGENTS sidebar card, no streaming progress, no cancel button.
  // Append a strong directive to the system prompt for this turn only
  // so the model picks build_app even when tool_choice is dropped.
  if (forceBuildIntent && resolved.provider === "anthropic") {
    systemPrompt +=
      `\n\n--- TURN DIRECTIVE ---\n` +
      `Intent classifier identified this turn as a build_app request: ${intentVerdict?.reason ?? "(no reason)"}.\n` +
      `You MUST call the build_app tool for this. Do NOT call write, edit, or glob to create the app files inline — ` +
      `that path skips canonical-loop tracking and the user will see no progress card. ` +
      `build_app spawns a background op that streams in the AGENTS sidebar and can be cancelled. ` +
      `If the user's request is small enough that you could write it inline, you should STILL use build_app — ` +
      `the user explicitly asked for an app.\n` +
      `--- END TURN DIRECTIVE ---\n`;
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
    toolChoice,
  };
}

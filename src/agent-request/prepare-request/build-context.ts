// Memory + per-turn context build. Handles three signals:
//   - image-aware recall scan tagging (so downstream reflex extends to
//     image-extracted entities, not only typed-text)
//   - Codex-specific contextBlock trim (128k models can't afford the
//     full 5,000+ token core_memory dump)
//   - weak-tier context strip (small local models can't separate
//     third-person facts from voice instructions and collapse into
//     fake first-person responses)

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { MemoryManager } from "../../memory/index.js";
import { buildTurnContextCached } from "../turn-context-cache.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("agent-request.prepare-request.context");

export interface BuildContextInput {
  message: string;
  sessionId: string;
  sessionMessages: ChatCompletionMessageParam[];
  memoryManager: MemoryManager;
  attachments?: Array<{ isImage: boolean; url: string; name: string }>;
  skipMemory?: boolean;
  isCodexProvider: boolean;
  isTrivialToolRequest: boolean;
  tier: "weak" | "medium" | "strong";
  resolvedModel: string;
}

export interface BuildContextResult {
  contextBlock: string;
  relevantMemories: string;
  smartContext: string;
  memoryContext: string;
  notifications: Awaited<ReturnType<typeof buildTurnContextCached>>["notifications"];
  knownProjectsFound: boolean;
}

export async function buildContext(input: BuildContextInput): Promise<BuildContextResult> {
  // v3.2: image-aware recall-reflex (revised). Earlier draft tried a
  // separate vision pre-extract call before the main turn, but that
  // assumed plain API keys (OPENAI_API_KEY / sk-ant-api03-*) most users
  // don't have — Codex/Claude subscription auth routes through CLIs that
  // either don't expose vision or strip images. Instead: the main agent
  // already has vision (gpt-5.5, Sonnet, etc.). Just flag for the system-
  // prompt nudge that an image is attached so the agent's reflex extends
  // to image-extracted entities, not only typed-text entities.
  let recallScanText = input.message;
  if (input.attachments && input.attachments.some((a) => a.isImage)) {
    // Tag the recall-scan input so downstream code (orchestrator,
    // known-projects scan) knows to be conservative about typed-text
    // matches and the system-prompt reflex knows an image is present.
    recallScanText = `${input.message}\n[user attached an image — reflex: identify any brand/project/domain you can read from it, then call search_past_sessions on that name before answering]`;
  }

  const bcT0 = Date.now();
  logger.info(`[step] buildTurnContextCached START sess=${input.sessionId.slice(0, 16)}`);
  const turnCtx = await buildTurnContextCached(input.memoryManager, {
    userMessage: recallScanText,
    sessionId: input.sessionId,
    sessionMessages: input.sessionMessages.slice(-20).map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
    })),
    skipDailyLog: input.isCodexProvider,
    liteMode: !input.skipMemory && input.isTrivialToolRequest,
    minimalMode: input.skipMemory,
  });
  logger.info(`[step] buildTurnContextCached ${Date.now() - bcT0}ms sess=${input.sessionId.slice(0, 16)}`);
  let contextBlock = turnCtx.contextBlock;
  let relevantMemories = turnCtx.relevantMemories;
  let smartContext = turnCtx.smartContext;
  let memoryContext = turnCtx.memoryContext;
  let knownProjectsFound = turnCtx.knownProjectsFound;
  const notifications = turnCtx.notifications;
  if (input.isTrivialToolRequest && !input.skipMemory) logger.info(`[chat] Trivial tool request — skipping memory injection`);
  else if (input.isCodexProvider && !input.skipMemory) logger.info(`[chat] Codex provider — daily log skipped`);

  // For Codex (128k context), cap the memory context block. The full
  // core_memory dump can be 5,000+ tokens of retained facts — essential
  // for 200k+ models but overkill for casual chat on a tight budget.
  // Keep identity + profile + today context, trim core_memory to first 2k chars.
  if (input.isCodexProvider && contextBlock.length > 3000) {
    contextBlock = contextBlock.replace(
      /<core_memory>([\s\S]*?)<\/core_memory>/,
      (_, content: string) => `<core_memory>\n${content.slice(0, 2000)}\n[...truncated for context budget]\n</core_memory>`
    );
  }

  // Weak-model context strip. Small local models (qwen2:7b, llama3:8b,
  // qwen2.5:7b) cannot reliably separate "third-person facts about the
  // user" from "instructions for what voice to write in" — the bulky
  // user-profile + core_memory + RAG-hit context blocks trigger them to
  // collapse into the user's first-person voice and produce a fake
  // nightly-update-as-the-user response. The Voice Guard in the base
  // prompt helps, but the cleaner fix on weak models is to not put
  // most of that context in front of them in the first place. Strong
  // models (Sonnet/Opus, gpt-5-class) keep the full context — they
  // parse it as third-person info correctly.
  if (input.tier === "weak") {
    contextBlock = "";
    relevantMemories = "";
    smartContext = "";
    memoryContext = "";
    knownProjectsFound = false;
    logger.info(`[chat] weak tier ${input.resolvedModel} — stripped memory/profile context to prevent roleplay drift`);
  }

  return { contextBlock, relevantMemories, smartContext, memoryContext, notifications, knownProjectsFound };
}

export function isTrivialToolRequest(message: string): boolean {
  const m = message.trim();
  return /^(run\s+(bash|command)|execute|bash)\s*(with|:)/i.test(m) ||
    /^(ls|dir|cat|echo|Write-Output|Get-ChildItem|pwd|whoami|git\s)/i.test(m);
}

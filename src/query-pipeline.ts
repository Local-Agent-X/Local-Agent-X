/**
 * Query Pipeline — composable middleware for LLM queries.
 *
 * Instead of a monolithic agent loop, queries pass through a pipeline:
 *   pre-process → route → execute → post-process
 *
 * Each stage is a middleware function that can modify the query, add context,
 * pick models, validate output, or trigger retries.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentTurn } from "./types.js";

import { createLogger } from "./logger.js";
const logger = createLogger("query-pipeline");

// ── Types ──

export interface QueryContext {
  userMessage: string;
  history: ChatCompletionMessageParam[];
  systemPrompt: string;
  model: string;
  provider: string;
  temperature: number;
  sessionId: string;
  /** Metadata passed between middleware stages */
  meta: Record<string, unknown>;
  /** Set by router middleware to override model/provider */
  routedModel?: string;
  routedProvider?: string;
}

export interface QueryResult {
  turn: AgentTurn;
  context: QueryContext;
  /** Quality score from post-processing (0-100) */
  qualityScore?: number;
  /** Cost in USD for this query */
  costUsd?: number;
}

export type PreMiddleware = (ctx: QueryContext) => Promise<QueryContext> | QueryContext;
export type PostMiddleware = (result: QueryResult) => Promise<QueryResult> | QueryResult;

// ── Pipeline ──

export class QueryPipeline {
  private preMiddleware: PreMiddleware[] = [];
  private postMiddleware: PostMiddleware[] = [];

  /** Add a pre-processing middleware (runs before LLM call) */
  pre(fn: PreMiddleware): this { this.preMiddleware.push(fn); return this; }

  /** Add a post-processing middleware (runs after LLM call) */
  post(fn: PostMiddleware): this { this.postMiddleware.push(fn); return this; }

  /** Run all pre-middleware on a context */
  async runPre(ctx: QueryContext): Promise<QueryContext> {
    let result = ctx;
    for (const fn of this.preMiddleware) {
      result = await fn(result);
    }
    return result;
  }

  /** Run all post-middleware on a result */
  async runPost(result: QueryResult): Promise<QueryResult> {
    let r = result;
    for (const fn of this.postMiddleware) {
      r = await fn(r);
    }
    return r;
  }
}

// ── Built-in Middleware ──

/**
 * Smart model router — picks cheaper models for simple queries,
 * expensive ones for complex tasks.
 */
export function modelRouter(): PreMiddleware {
  return (ctx: QueryContext) => {
    const msg = ctx.userMessage.toLowerCase();
    const len = ctx.userMessage.length;
    const histLen = ctx.history.length;

    // Simple queries: greetings, yes/no, short questions
    const isSimple = len < 100 && histLen < 4 &&
      (/^(hi|hey|hello|yo|sup|thanks|ok|yes|no|sure)\b/i.test(msg) ||
       /^(what time|what day|what date)/i.test(msg));

    if (isSimple) {
      ctx.meta.routeReason = "simple-query";
      // Don't override model — let the user's chosen model handle it
      // But mark it so cost tracker can note the opportunity
    }

    // Complex tasks: long prompts, code, multi-step
    const isComplex = len > 500 || histLen > 20 ||
      /\b(build|create|implement|refactor|analyze|research|compare)\b/i.test(msg);

    if (isComplex) {
      ctx.meta.routeReason = "complex-task";
      ctx.meta.suggestHigherIterations = true;
    }

    return ctx;
  };
}

/**
 * Cost estimation middleware — computes cost WITHOUT recording it.
 * Recording happens in chat.ts (the single authoritative source).
 */
export function costEstimator(): PostMiddleware {
  return async (result: QueryResult) => {
    try {
      const { getPricing } = await import("./cost-tracker.js");
      const pricing = getPricing(result.context.routedModel || result.context.model);
      result.costUsd = (result.turn.usage.promptTokens * pricing.input + result.turn.usage.completionTokens * pricing.output) / 1_000_000;
    } catch {}
    return result;
  };
}

/**
 * Quality scoring middleware — scores the output and flags low-quality responses.
 */
export function qualityGate(): PostMiddleware {
  return async (result: QueryResult) => {
    try {
      const { scoreResponse } = await import("./quality-scorer.js");
      const assistantMsgs = result.turn.messages
        .filter(m => m.role === "assistant" && typeof m.content === "string");
      const lastMsg = assistantMsgs[assistantMsgs.length - 1];
      if (lastMsg && typeof lastMsg.content === "string") {
        const toolMsgs = result.turn.messages.filter(m => m.role === "tool");
        const errorMsgs = toolMsgs.filter(m => typeof m.content === "string" && /error|failed|blocked/i.test(m.content as string));
        const score = scoreResponse(lastMsg.content, {
          toolsUsed: toolMsgs.length,
          toolsAvailable: true,
          hasErrors: errorMsgs.length > 0,
          isComplete: result.turn.stopReason === "end_turn",
          sessionId: result.context.sessionId,
        });
        result.qualityScore = score.overall;
      }
    } catch {}
    return result;
  };
}

/**
 * Logging middleware — logs query details for debugging.
 */
export function queryLogger(): PostMiddleware {
  return (result: QueryResult) => {
    const cost = result.costUsd ? ` ($${result.costUsd.toFixed(4)})` : "";
    const quality = result.qualityScore !== undefined ? ` [quality: ${result.qualityScore}]` : "";
    logger.info(`[pipeline] ${result.context.model} | ${result.turn.usage.totalTokens} tokens${cost}${quality} | ${result.turn.stopReason}`);
    return result;
  };
}

// ── Default Pipeline ──

let _defaultPipeline: QueryPipeline | null = null;

export function getDefaultPipeline(): QueryPipeline {
  if (!_defaultPipeline) {
    _defaultPipeline = new QueryPipeline()
      .pre(modelRouter())
      .post(costEstimator())
      .post(qualityGate())
      .post(queryLogger());
  }
  return _defaultPipeline;
}

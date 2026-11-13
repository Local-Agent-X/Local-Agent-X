/**
 * How much transcript the compaction summarizer reads, how much it may write,
 * and how long it gets.
 *
 * The summarizer is the user's own chat provider and model (classifyWithLLM,
 * role "review"). On a local runtime it runs at DISPATCH_NUM_CTX (16,384
 * tokens), and Ollama truncates an over-long prompt from the FRONT, dropping
 * the instructions (2026-09-14) — hence the fixed 30,000-character transcript.
 * That bound was applied to every provider, so a hosted model with a
 * 1M-token window summarized a long coding session from about 7,500 tokens of
 * it, each tool result cut to 400 characters. A hosted summarizer now reads up
 * to a quarter of its window (capped), with the per-row clips, the reply and
 * the timeout scaled alike. Local and custom endpoints keep the old bound:
 * their real context is not known here.
 */
import { resolveProviderContext } from "../providers/resolve-provider-context.js";

export interface SummaryBudget {
  transcriptChars: number;
  /** Per-row clip by kind: user rows carry the constraints, so they keep most. */
  rowChars: { user: number; assistant: number; tool: number };
  replyChars: number;
  timeoutMs: number;
}

export const LOCAL_SUMMARY_BUDGET: SummaryBudget = {
  transcriptChars: 30_000,
  rowChars: { user: 2000, assistant: 800, tool: 400 },
  replyChars: 6000,
  timeoutMs: 30_000,
};

/** Providers whose context is not known from the model name. */
const UNSIZED_PROVIDERS = new Set(["local", "custom"]);
const WINDOW_SHARE = 0.25;
const MAX_TRANSCRIPT_TOKENS = 120_000;
/** Dense text (code, snapshots) runs near 3 characters a token. */
const CHARS_PER_TOKEN = 3;
const MAX_ROW_SCALE = 8;
const MAX_REPLY_CHARS = 24_000;
const MAX_TIMEOUT_MS = 120_000;

/** The budget for a summarizer on `provider` whose window is `windowTokens`. */
export function summaryBudgetFor(provider: string | undefined, windowTokens: number | undefined): SummaryBudget {
  if (!provider || UNSIZED_PROVIDERS.has(provider) || !windowTokens || windowTokens <= 0) return LOCAL_SUMMARY_BUDGET;
  const base = LOCAL_SUMMARY_BUDGET;
  const tokens = Math.min(windowTokens * WINDOW_SHARE, MAX_TRANSCRIPT_TOKENS);
  const transcriptChars = Math.max(base.transcriptChars, Math.floor(tokens * CHARS_PER_TOKEN));
  const scale = transcriptChars / base.transcriptChars;
  const rows = Math.min(scale, MAX_ROW_SCALE);
  return {
    transcriptChars,
    rowChars: { user: Math.floor(base.rowChars.user * rows), assistant: Math.floor(base.rowChars.assistant * rows), tool: Math.floor(base.rowChars.tool * rows) },
    replyChars: Math.min(Math.floor(base.replyChars * scale), MAX_REPLY_CHARS),
    timeoutMs: Math.min(base.timeoutMs + Math.floor(transcriptChars / 10_000) * 3_000, MAX_TIMEOUT_MS),
  };
}

/** The budget for the user's current chat provider (the summarizer's own). */
export async function currentSummaryBudget(windowTokens: number | undefined): Promise<SummaryBudget> {
  if (!windowTokens) return LOCAL_SUMMARY_BUDGET;
  const ctx = await resolveProviderContext().catch(() => null);
  return summaryBudgetFor(ctx?.provider, windowTokens);
}

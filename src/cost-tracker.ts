/**
 * Cost Tracker — tracks token usage and costs per session, per agent, per model.
 * Stores in SQLite for persistence. Provides real-time cost estimates and
 * cumulative spending dashboards.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";
import type { CredentialSource } from "./auth/auth-provider.js";
import { createLogger } from "./logger.js";

const logger = createLogger("cost-tracker");

// ── Billing mode ──
// A flat-rate subscription (oauth: Claude CLI / SuperGrok / ChatGPT) costs $0
// per call — the token×price figure is a *shadow* cost, never real money. Local
// models (sentinel) are free. Everything else is a real per-token API key. The
// USD spend cap must bill only the latter; otherwise it falsely blocks a
// subscription user whose marginal cost is zero. `undefined` is treated as
// billable so an untagged record never silently escapes the cap.
export function isBillableSource(source: CredentialSource | undefined): boolean {
  return source !== "oauth" && source !== "sentinel";
}

// Process-level latest resolved billing mode + model, set each turn by
// prepareAgentRequest. Lets the spend-cap pack short-circuit the USD cap for a
// subscription user (before any record carries a source) and know which model a
// per-model cap should apply to.
let _lastResolvedAuthSource: CredentialSource | undefined;
let _lastResolvedModel: string | undefined;
export function noteResolvedAuthSource(source: CredentialSource | undefined): void {
  if (source) _lastResolvedAuthSource = source;
}
export function getResolvedAuthSource(): CredentialSource | undefined {
  return _lastResolvedAuthSource;
}
export function noteResolvedModel(model: string | undefined): void {
  if (model) _lastResolvedModel = model;
}
export function getResolvedModel(): string | undefined {
  return _lastResolvedModel;
}

// ── Pricing per 1M tokens (USD) ──

interface ModelPricing { input: number; output: number }

const PRICING: Record<string, ModelPricing> = {
  // Anthropic (dated + short aliases)
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-5-20251101": { input: 5, output: 25 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-3-5-20241022": { input: 0.80, output: 4 },
  // OpenAI / Codex (GPT-5.x — developers.openai.com/api/docs/pricing)
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.4": { input: 2.50, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.50 },
  "gpt-4o": { input: 2.50, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
  "gpt-4.1-nano": { input: 0.10, output: 0.40 },
  "o3": { input: 2, output: 8 },
  "o3-pro": { input: 20, output: 80 },
  "o4-mini": { input: 1.10, output: 4.40 },
  // xAI (grok-4.3 + 4.20 family all $1.25/$2.50, cached $0.20 — x.ai/api)
  "grok-4.3": { input: 1.25, output: 2.50 },
  "grok-4.20-0309-reasoning": { input: 1.25, output: 2.50 },
  "grok-4.20-0309-non-reasoning": { input: 1.25, output: 2.50 },
  "grok-4.20-multi-agent-0309": { input: 1.25, output: 2.50 },
  "grok-code-fast-1": { input: 0.20, output: 1.50 },
  "grok-build-0.1": { input: 0.20, output: 1.50 }, // est — coding model, priced as grok-code-fast-1
  "grok-4": { input: 3, output: 15 },
  "grok-4-fast": { input: 0.20, output: 0.50 },
  "grok-4-heavy": { input: 5, output: 25 },
  "grok-3": { input: 3, output: 15 },
  "grok-3-mini": { input: 0.30, output: 0.50 },
  "grok-2": { input: 2, output: 10 },
  // Gemini (≤200k context tier — ai.google.dev/gemini-api/docs/pricing)
  "gemini-3.1-pro-preview": { input: 2, output: 12 }, // est — priced as gemini-3-pro
  "gemini-3-pro-preview": { input: 2, output: 12 },
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-pro-preview": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.15, output: 0.60 },
  "gemini-2.5-flash-preview": { input: 0.15, output: 0.60 },
  "gemini-2.0-flash": { input: 0.10, output: 0.40 },
  // Cerebras (OSS inference — est, not gate-required)
  "gpt-oss-120b": { input: 0.35, output: 0.75 },
  "zai-glm-4.7": { input: 0.40, output: 1.60 },
  // Local models (free)
  "llama": { input: 0, output: 0 },
  "mistral": { input: 0, output: 0 },
  "qwen": { input: 0, output: 0 },
  "deepseek": { input: 0, output: 0 },
  "phi": { input: 0, output: 0 },
  "gemma": { input: 0, output: 0 },
};

/** When the rates above were last verified against provider pricing pages.
 *  check:pricing-coverage warns once this is older than the staleness window —
 *  a nudge to re-check, since a hardcoded table can't know a provider repriced. */
export const PRICES_VERIFIED_AT = "2026-06-28";

type PricingSource = "exact" | "prefix" | "fallback";

/** Resolve a model's rate AND how confident we are in it. `exact` = a table
 *  entry; `prefix` = a startsWith alias (e.g. dated/[1m] suffixes of a real
 *  entry); `fallback` = no match, so the mid-road default — that's a guess, and
 *  callers flag it (loud fallback) so a stale price can't masquerade as fact. */
function resolvePricing(model: string): { pricing: ModelPricing; source: PricingSource } {
  if (PRICING[model]) return { pricing: PRICING[model], source: "exact" };
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return { pricing, source: "prefix" };
  }
  return { pricing: { input: 3, output: 15 }, source: "fallback" };
}

export function getPricing(model: string): ModelPricing {
  return resolvePricing(model).pricing;
}

/** True only for an exact table entry — what the build-time coverage gate
 *  requires of every selectable model, so the grok-4.3 class (a real model
 *  silently prefix-matched to the wrong tier) can't ship. */
export function hasExactPricing(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRICING, model);
}

// ── Usage Record ──

export interface UsageRecord {
  sessionId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  timestamp: number;
  agentId?: string;
  /** How the credential was sourced. `oauth`/`sentinel` = $0 real cost; the
   *  USD spend cap bills only records where `isBillableSource` is true. */
  authSource?: CredentialSource;
  /** Set when the model had no price entry and fell back to the default rate,
   *  so `costUsd` is a guess — surfaced as "≈ est." rather than presented as
   *  fact. Absent on a real (exact/prefix) price. */
  pricingEstimated?: boolean;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  recordCount: number;
  byModel: Record<string, { input: number; output: number; cost: number }>;
  bySession: Record<string, { input: number; output: number; cost: number }>;
}

// ── File-based storage (lightweight, no extra deps) ──

const USAGE_FILE = join(getLaxDir(), "usage-log.json");
const MAX_RECORDS = 10000;

function loadRecords(): UsageRecord[] {
  try {
    if (existsSync(USAGE_FILE)) return JSON.parse(readFileSync(USAGE_FILE, "utf-8"));
  } catch {}
  return [];
}

function saveRecords(records: UsageRecord[]): void {
  // Keep only last MAX_RECORDS
  const trimmed = records.length > MAX_RECORDS ? records.slice(-MAX_RECORDS) : records;
  writeFileSync(USAGE_FILE, JSON.stringify(trimmed), "utf-8");
}

// ── Public API ──

export function trackUsage(
  sessionId: string,
  model: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
  agentId?: string,
  authSource?: CredentialSource,
): UsageRecord {
  const { pricing, source } = resolvePricing(model);
  const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

  const record: UsageRecord = {
    sessionId, model, provider, inputTokens, outputTokens,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000, // 6 decimal places
    timestamp: Date.now(),
    agentId,
    authSource,
    ...(source === "fallback" ? { pricingEstimated: true } : {}),
  };
  if (source === "fallback") {
    logger.warn(`[cost] no price for model "${model}" — using default $${pricing.input}/$${pricing.output} per 1M (estimate). Add it to PRICING.`);
  }

  const records = loadRecords();
  records.push(record);
  saveRecords(records);

  return record;
}

export function getUsageSummary(filter?: {
  since?: number;
  sessionId?: string;
  agentId?: string;
}): UsageSummary {
  let records = loadRecords();

  if (filter?.since) records = records.filter(r => r.timestamp >= filter.since!);
  if (filter?.sessionId) records = records.filter(r => r.sessionId === filter.sessionId);
  if (filter?.agentId) records = records.filter(r => r.agentId === filter.agentId);

  const summary: UsageSummary = {
    totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0,
    recordCount: records.length, byModel: {}, bySession: {},
  };

  for (const r of records) {
    summary.totalInputTokens += r.inputTokens;
    summary.totalOutputTokens += r.outputTokens;
    summary.totalCostUsd += r.costUsd;

    if (!summary.byModel[r.model]) summary.byModel[r.model] = { input: 0, output: 0, cost: 0 };
    summary.byModel[r.model].input += r.inputTokens;
    summary.byModel[r.model].output += r.outputTokens;
    summary.byModel[r.model].cost += r.costUsd;

    if (!summary.bySession[r.sessionId]) summary.bySession[r.sessionId] = { input: 0, output: 0, cost: 0 };
    summary.bySession[r.sessionId].input += r.inputTokens;
    summary.bySession[r.sessionId].output += r.outputTokens;
    summary.bySession[r.sessionId].cost += r.costUsd;
  }

  summary.totalCostUsd = Math.round(summary.totalCostUsd * 100) / 100;
  return summary;
}

export function getSessionCost(sessionId: string): { inputTokens: number; outputTokens: number; costUsd: number } {
  const records = loadRecords().filter(r => r.sessionId === sessionId);
  const input = records.reduce((s, r) => s + r.inputTokens, 0);
  const output = records.reduce((s, r) => s + r.outputTokens, 0);
  const cost = records.reduce((s, r) => s + r.costUsd, 0);
  return { inputTokens: input, outputTokens: output, costUsd: Math.round(cost * 100) / 100 };
}

export function getTodayCost(): { costUsd: number; inputTokens: number; outputTokens: number } {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const summary = getUsageSummary({ since: startOfDay.getTime() });
  return { costUsd: summary.totalCostUsd, inputTokens: summary.totalInputTokens, outputTokens: summary.totalOutputTokens };
}

/** Real-money spend only — sums records on a per-call API key, excluding
 *  flat-rate subscription/local usage. This is what the USD spend cap enforces;
 *  `getTodayCost` keeps the full (incl. shadow) total for display. */
export function getTodayBillableCost(): { costUsd: number; shadowUsd: number } {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  return getBillableCostSince(startOfDay.getTime());
}

/** Period-aware billable/shadow split — `sinceMs` undefined = all-time. Backs
 *  the usage dashboard's honest "real spend vs estimated" framing. */
export function getBillableCostSince(sinceMs?: number): { costUsd: number; shadowUsd: number } {
  const records = sinceMs ? loadRecords().filter(r => r.timestamp >= sinceMs) : loadRecords();
  return sumBillable(records);
}

/** Real (billable) spend for ONE model since `sinceMs` — what a per-model daily
 *  cap enforces. Subscription/local records for the model contribute $0, so a
 *  per-model cap only ever bites real per-call API spend. */
export function getBillableCostForModelSince(model: string, sinceMs?: number): number {
  let billable = 0;
  for (const r of loadRecords()) {
    if (r.model !== model) continue;
    if (sinceMs && r.timestamp < sinceMs) continue;
    if (isBillableSource(r.authSource)) billable += r.costUsd;
  }
  return Math.round(billable * 1_000_000) / 1_000_000;
}

export interface ModelBreakdownEntry {
  input: number;
  output: number;
  cost: number;
  provider: string;
  /** True when this model was used on a real per-call API key (so it's eligible
   *  for a per-model spend cap). Subscription/local usage is display-only. */
  billable: boolean;
}

/** Per-model usage for the dashboard: tokens, cost, provider, and whether it's a
 *  real-money (API-key) model — the dashboard only offers a limit picker for
 *  billable models. */
export function getModelBreakdown(sinceMs?: number): Record<string, ModelBreakdownEntry> {
  const out: Record<string, ModelBreakdownEntry> = {};
  for (const r of loadRecords()) {
    if (sinceMs && r.timestamp < sinceMs) continue;
    const e = (out[r.model] ??= { input: 0, output: 0, cost: 0, provider: r.provider, billable: false });
    e.input += r.inputTokens;
    e.output += r.outputTokens;
    e.cost += r.costUsd;
    if (r.provider) e.provider = r.provider;
    if (isBillableSource(r.authSource)) e.billable = true;
  }
  for (const e of Object.values(out)) e.cost = Math.round(e.cost * 1_000_000) / 1_000_000;
  return out;
}

export function getSessionBillableCost(sessionId: string): { costUsd: number; shadowUsd: number } {
  return sumBillable(loadRecords().filter(r => r.sessionId === sessionId));
}

function sumBillable(records: UsageRecord[]): { costUsd: number; shadowUsd: number } {
  let billable = 0;
  let shadow = 0;
  for (const r of records) {
    if (isBillableSource(r.authSource)) billable += r.costUsd;
    else shadow += r.costUsd;
  }
  return { costUsd: Math.round(billable * 100) / 100, shadowUsd: Math.round(shadow * 100) / 100 };
}

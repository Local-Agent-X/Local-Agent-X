/**
 * Cost Tracker — tracks token usage and costs per session, per agent, per model.
 * Stores in SQLite for persistence. Provides real-time cost estimates and
 * cumulative spending dashboards.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "./lax-data-dir.js";

// ── Pricing per 1M tokens (USD) ──

interface ModelPricing { input: number; output: number }

const PRICING: Record<string, ModelPricing> = {
  // Anthropic (dated + short aliases)
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
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
  // OpenAI
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-4o": { input: 2.50, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
  "gpt-4.1-nano": { input: 0.10, output: 0.40 },
  "o3": { input: 2, output: 8 },
  "o3-pro": { input: 20, output: 80 },
  "o4-mini": { input: 1.10, output: 4.40 },
  // xAI
  "grok-4": { input: 3, output: 15 },
  "grok-4-fast": { input: 0.20, output: 0.50 },
  "grok-4-heavy": { input: 5, output: 25 },
  "grok-code-fast-1": { input: 0.20, output: 1.50 },
  "grok-3": { input: 3, output: 15 },
  "grok-3-mini": { input: 0.30, output: 0.50 },
  "grok-2": { input: 2, output: 10 },
  // Gemini
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-pro-preview": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.15, output: 0.60 },
  "gemini-2.5-flash-preview": { input: 0.15, output: 0.60 },
  "gemini-2.0-flash": { input: 0.10, output: 0.40 },
  // Local models (free)
  "llama": { input: 0, output: 0 },
  "mistral": { input: 0, output: 0 },
  "qwen": { input: 0, output: 0 },
  "deepseek": { input: 0, output: 0 },
  "phi": { input: 0, output: 0 },
  "gemma": { input: 0, output: 0 },
};

export function getPricing(model: string): ModelPricing {
  if (PRICING[model]) return PRICING[model];
  // Fuzzy match: check if model starts with a known key
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  // Default: middle-of-road pricing for unknown models
  return { input: 3, output: 15 };
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
): UsageRecord {
  const pricing = getPricing(model);
  const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

  const record: UsageRecord = {
    sessionId, model, provider, inputTokens, outputTokens,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000, // 6 decimal places
    timestamp: Date.now(),
    agentId,
  };

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

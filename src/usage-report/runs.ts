/**
 * Where the tokens went: the most expensive recent runs, each with what it was,
 * why it ran, how many model calls it made, how big they were, how much came
 * from the provider's cache, and a plain flag for what is out of the ordinary.
 *
 * Built to answer in one screen what took an afternoon of scripts on 2026-11-27:
 * a build lead re-sending ~245K tokens per decision, one chat turn of 194 calls at
 * ~300K each, 58 builder and reviewer runs. Read from what every op already keeps
 * (its record and its per-call usage, canonical-loop opCallUsage); nothing is
 * logged for it. Dollar figures are what the tokens would cost at API prices: on a
 * subscription a call costs nothing extra, so tokens are the measure.
 */
import { opCallUsage, type OpCallUsage } from "../canonical-loop/public/op-facts.js";
import { listRecentOps, readOp } from "../ops/op-store.js";
import { getPricing, usageCostUsd } from "../cost-tracker.js";
import type { Op } from "../ops/types.js";
import { runKindOf, type RunKindInfo } from "./run-kind.js";
import { promptMakeup, type PromptPart } from "./prompt-makeup.js";

export interface RunSummary extends RunKindInfo {
  opId: string;
  sessionId: string | null;
  model: string | null;
  startedAt: string;
  calls: number;
  /** Every call's whole prompt, summed: what the run sent. */
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** The biggest single call's prompt. */
  peakPromptTokens: number;
  /** At API prices, cached tokens at the cache rate. */
  apiPriceUsd: number;
  /** What stands out, in words ("194 calls in one run"). */
  flags: string[];
}

/** How many recent ops are read to find the window's runs. */
const SCAN_LIMIT = 600;

// Thresholds a run is flagged at. Plain numbers so the screen can say why.
const MANY_CALLS = 50;
const BIG_PROMPT = 200_000;
const LOW_CACHE_SHARE = 0.4;
const REPEATS = 3;
const TOOL_LOOKUPS = 10;

/** The same tool with the same arguments, called most often in the run. */
function mostRepeated(calls: OpCallUsage[]): { tool: string; times: number } | null {
  const counts = new Map<string, { tool: string; times: number }>();
  for (const c of calls) {
    for (const t of c.tools) {
      const key = `${t.tool}\u0000${t.argsHash}`;
      const hit = counts.get(key) ?? { tool: t.tool, times: 0 };
      hit.times++;
      counts.set(key, hit);
    }
  }
  let top: { tool: string; times: number } | null = null;
  for (const v of counts.values()) if (!top || v.times > top.times) top = v;
  return top;
}

export function flagsOf(calls: OpCallUsage[], promptTokens: number, cachedTokens: number, peak: number): string[] {
  const flags: string[] = [];
  if (calls.length >= MANY_CALLS) flags.push(`${calls.length} calls in one run`);
  if (peak >= BIG_PROMPT) flags.push(`~${Math.round(peak / 1000)}K tokens in its biggest call`);
  // A lane that reports no cache figure at all reads as 0%: say that, not that
  // nothing was cached.
  if (calls.length >= 5 && promptTokens > 0) {
    if (cachedTokens === 0) flags.push("no cache use reported");
    else if (cachedTokens / promptTokens < LOW_CACHE_SHARE) flags.push(`only ${Math.round((100 * cachedTokens) / promptTokens)}% from cache`);
  }
  const repeated = mostRepeated(calls);
  if (repeated && repeated.times >= REPEATS) flags.push(`${repeated.tool} called ${repeated.times}× with the same arguments`);
  const lookups = calls.reduce((n, c) => n + c.tools.filter((t) => t.tool === "tool_search").length, 0);
  if (lookups >= TOOL_LOOKUPS) flags.push(`${lookups} tool lookups`);
  return flags;
}

function summarize(op: Op, calls: OpCallUsage[]): RunSummary {
  const promptTokens = calls.reduce((n, c) => n + c.promptTokens, 0);
  const cachedTokens = calls.reduce((n, c) => n + c.cachedTokens, 0);
  const outputTokens = calls.reduce((n, c) => n + c.outputTokens, 0);
  const peak = calls.reduce((n, c) => Math.max(n, c.promptTokens), 0);
  const model = op.model ?? ((op.contextPack?.routing as { preferredModel?: string } | undefined)?.preferredModel ?? null);
  return {
    opId: op.id,
    sessionId: op.sessionId ?? null,
    model,
    startedAt: op.startedAt ?? op.createdAt,
    calls: calls.length,
    promptTokens,
    cachedTokens,
    outputTokens,
    peakPromptTokens: peak,
    apiPriceUsd: model ? Math.round(usageCostUsd(model, promptTokens - cachedTokens, outputTokens, { readTokens: cachedTokens }) * 100) / 100 : 0,
    flags: flagsOf(calls, promptTokens, cachedTokens, peak),
    ...runKindOf(op),
  };
}

/** Every run started in the last `hours` that made a model call, most tokens first. */
function runsSince(hours: number): RunSummary[] {
  const since = Date.now() - hours * 3_600_000;
  return listRecentOps(SCAN_LIMIT)
    .filter((op) => Date.parse(op.startedAt ?? op.createdAt) >= since)
    .map((op) => summarize(op, opCallUsage(op.id)))
    .filter((run) => run.calls > 0)
    .sort((a, b) => b.promptTokens - a.promptTokens);
}

export interface RunGroup {
  kind: RunKindInfo["kind"];
  reason: string;
  runs: number;
  promptTokens: number;
  apiPriceUsd: number;
}

/** The window's runs by why they ran: how many builds, reviews, decisions, and
 *  what each kind cost in all. */
function groupByReason(runs: RunSummary[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  for (const run of runs) {
    const key = `${run.kind}\u0000${run.reason}`;
    const g = groups.get(key) ?? { kind: run.kind, reason: run.reason, runs: 0, promptTokens: 0, apiPriceUsd: 0 };
    g.runs++;
    g.promptTokens += run.promptTokens;
    g.apiPriceUsd = Math.round((g.apiPriceUsd + run.apiPriceUsd) * 100) / 100;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.promptTokens - a.promptTokens);
}

export interface UsageReport {
  hours: number;
  /** The most expensive runs. */
  runs: RunSummary[];
  /** Every run in the window, by why it ran. */
  groups: RunGroup[];
  /** All of the window's runs together. */
  total: { runs: number; promptTokens: number; cachedTokens: number; outputTokens: number; apiPriceUsd: number };
}

/** The Usage tab's "where it went": one pass over the window's runs. */
export function usageReport(hours: number, top = 40): UsageReport {
  const all = runsSince(hours);
  const sum = (f: (r: RunSummary) => number) => all.reduce((n, r) => n + f(r), 0);
  return {
    hours,
    runs: all.slice(0, top),
    groups: groupByReason(all),
    total: {
      runs: all.length,
      promptTokens: sum((r) => r.promptTokens),
      cachedTokens: sum((r) => r.cachedTokens),
      outputTokens: sum((r) => r.outputTokens),
      apiPriceUsd: Math.round(sum((r) => r.apiPriceUsd) * 100) / 100,
    },
  };
}

export interface RunDetail {
  run: RunSummary;
  /** Every call: its prompt, cached share, output and tools. */
  calls: OpCallUsage[];
  /** Tool name → times called in the run. */
  toolCounts: Record<string, number>;
  /** Pricing per million tokens the dollar figure used. */
  pricing: { input: number; output: number } | null;
  /** The biggest call, and what its prompt was made of (null: not readable). */
  biggestCall: { turnIdx: number; promptTokens: number; makeup: PromptPart[] | null } | null;
}

export function runDetail(opId: string): RunDetail | null {
  const op = readOp(opId);
  if (!op) return null;
  const calls = opCallUsage(opId);
  const toolCounts: Record<string, number> = {};
  for (const c of calls) for (const t of c.tools) toolCounts[t.tool] = (toolCounts[t.tool] ?? 0) + 1;
  const run = summarize(op, calls);
  const pricing = run.model ? getPricing(run.model) : null;
  const biggest = calls.reduce<OpCallUsage | null>((top, c) => (!top || c.promptTokens > top.promptTokens ? c : top), null);
  return {
    run, calls, toolCounts,
    pricing: pricing ? { input: pricing.input, output: pricing.output } : null,
    biggestCall: biggest ? { turnIdx: biggest.turnIdx, promptTokens: biggest.promptTokens, makeup: promptMakeup(opId, biggest.turnIdx, biggest.promptTokens) } : null,
  };
}

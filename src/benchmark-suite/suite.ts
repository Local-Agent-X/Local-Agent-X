import { writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import type {
  Benchmark,
  BenchmarkCategory,
  BenchmarkScore,
  CategorySummary,
  BenchmarkRunResult,
  ProviderComparison,
  SendPromptFn,
} from "./types.js";
import { ALL_BUILT_IN } from "./benchmarks.js";
import { resultsToMarkdown, comparisonToMarkdown } from "./formatters.js";

const BENCHMARKS_DIR = join(homedir(), ".lax", "benchmarks");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export class BenchmarkSuite {
  private benchmarks: Benchmark[] = [...ALL_BUILT_IN];
  private results: BenchmarkRunResult[] = [];
  private sendPrompt: SendPromptFn | null = null;

  constructor(sendPrompt?: SendPromptFn) {
    this.sendPrompt = sendPrompt ?? null;
  }

  setSendPrompt(fn: SendPromptFn): void {
    this.sendPrompt = fn;
  }

  addBenchmark(bench: Benchmark): void {
    this.benchmarks.push(bench);
  }

  getBenchmarks(): Benchmark[] {
    return [...this.benchmarks];
  }

  getBenchmarksByCategory(category: BenchmarkCategory): Benchmark[] {
    return this.benchmarks.filter((b) => b.category === category);
  }

  async runAll(provider?: string, model?: string): Promise<BenchmarkRunResult> {
    return this.runBenchmarks(this.benchmarks, provider, model);
  }

  async runOne(name: string, provider?: string, model?: string): Promise<BenchmarkRunResult> {
    const bench = this.benchmarks.find((b) => b.name === name);
    if (!bench) {
      throw new Error(`Benchmark not found: ${name}`);
    }
    return this.runBenchmarks([bench], provider, model);
  }

  async runCategory(category: BenchmarkCategory, provider?: string, model?: string): Promise<BenchmarkRunResult> {
    const filtered = this.benchmarks.filter((b) => b.category === category);
    if (filtered.length === 0) {
      throw new Error(`No benchmarks found for category: ${category}`);
    }
    return this.runBenchmarks(filtered, provider, model);
  }

  getResults(): BenchmarkRunResult[] {
    return [...this.results];
  }

  compareProviders(results: BenchmarkRunResult[]): ProviderComparison {
    const providers = results.map((r) => r.provider);
    const allBenchNames = new Set<string>();
    const allCategories = new Set<BenchmarkCategory>();

    for (const result of results) {
      for (const score of result.scores) {
        allBenchNames.add(score.name);
        allCategories.add(score.category);
      }
    }

    const benchmarks = Array.from(allBenchNames);
    const table: Record<string, Record<string, number>> = {};
    const categoryTable: Record<string, Record<string, number>> = {};

    for (const result of results) {
      const providerKey = result.provider;
      table[providerKey] = {};
      for (const score of result.scores) {
        table[providerKey][score.name] = score.score;
      }
      categoryTable[providerKey] = {};
      for (const cat of result.categories) {
        categoryTable[providerKey][cat.category] = cat.avgScore;
      }
    }

    let winner = providers[0];
    let highestOverall = 0;
    for (const result of results) {
      if (result.overallScore > highestOverall) {
        highestOverall = result.overallScore;
        winner = result.provider;
      }
    }

    return { providers, benchmarks, table, categoryTable, winner };
  }

  saveResults(result: BenchmarkRunResult): string {
    ensureDir(BENCHMARKS_DIR);
    const filename = `${result.provider}-${result.timestamp.replace(/[:.]/g, "-")}.json`;
    const target = join(BENCHMARKS_DIR, filename);
    writeFileSync(target, JSON.stringify(result, null, 2), "utf-8");
    return target;
  }

  static loadResults(path: string): BenchmarkRunResult {
    if (!existsSync(path)) {
      throw new Error(`Results file not found: ${path}`);
    }
    return JSON.parse(readFileSync(path, "utf-8")) as BenchmarkRunResult;
  }

  static listSavedResults(): string[] {
    ensureDir(BENCHMARKS_DIR);
    return readdirSync(BENCHMARKS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(BENCHMARKS_DIR, f));
  }

  resultsToMarkdown(result: BenchmarkRunResult): string {
    return resultsToMarkdown(result);
  }

  comparisonToMarkdown(comparison: ProviderComparison): string {
    return comparisonToMarkdown(comparison);
  }

  private async runBenchmarks(benchmarks: Benchmark[], provider?: string, model?: string): Promise<BenchmarkRunResult> {
    if (!this.sendPrompt) {
      throw new Error("No sendPrompt function configured. Call setSendPrompt() first.");
    }

    const startTime = Date.now();
    const scores: BenchmarkScore[] = [];

    for (const bench of benchmarks) {
      const benchStart = Date.now();
      let response = "";

      try {
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("Benchmark timed out")), bench.timeout);
        });
        response = await Promise.race([
          this.sendPrompt(bench.prompt, provider),
          timeoutPromise,
        ]);
      } catch (err) {
        response = `[Error: ${err instanceof Error ? err.message : String(err)}]`;
      }

      const latencyMs = Date.now() - benchStart;
      const score = bench.validate(response);

      scores.push({
        name: bench.name,
        category: bench.category,
        score,
        latencyMs,
        response,
        passed: score >= 50,
      });
    }

    const totalDuration = Date.now() - startTime;
    const categories = this.summarizeCategories(scores);
    const overallScore = scores.length > 0
      ? scores.reduce((sum, s) => sum + s.score, 0) / scores.length
      : 0;

    const result: BenchmarkRunResult = {
      id: randomUUID(),
      provider: provider ?? "default",
      model: model ?? "unknown",
      timestamp: new Date().toISOString(),
      scores,
      categories,
      overallScore,
      totalDuration,
    };

    this.results.push(result);
    return result;
  }

  private summarizeCategories(scores: BenchmarkScore[]): CategorySummary[] {
    const grouped = new Map<BenchmarkCategory, number[]>();

    for (const score of scores) {
      const arr = grouped.get(score.category) ?? [];
      arr.push(score.score);
      grouped.set(score.category, arr);
    }

    const summaries: CategorySummary[] = [];
    for (const [category, values] of grouped) {
      summaries.push({
        category,
        avgScore: values.reduce((a, b) => a + b, 0) / values.length,
        minScore: Math.min(...values),
        maxScore: Math.max(...values),
        count: values.length,
      });
    }

    return summaries;
  }
}

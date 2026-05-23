import type { BenchmarkRunResult, ProviderComparison } from "./types.js";

export function resultsToMarkdown(result: BenchmarkRunResult): string {
  const lines: string[] = [];
  lines.push(`# Benchmark Results: ${result.provider}`);
  if (result.model) {
    lines.push(`**Model:** ${result.model}`);
  }
  lines.push(`**Date:** ${result.timestamp}`);
  lines.push(`**Overall Score:** ${result.overallScore.toFixed(1)}/100`);
  lines.push(`**Duration:** ${(result.totalDuration / 1000).toFixed(1)}s`);
  lines.push("");

  lines.push("## Category Summary");
  lines.push("");
  lines.push("| Category | Avg Score | Min | Max | Count |");
  lines.push("|----------|-----------|-----|-----|-------|");
  for (const cat of result.categories) {
    lines.push(`| ${cat.category} | ${cat.avgScore.toFixed(1)} | ${cat.minScore} | ${cat.maxScore} | ${cat.count} |`);
  }
  lines.push("");

  lines.push("## Individual Scores");
  lines.push("");
  lines.push("| Benchmark | Category | Score | Latency | Pass |");
  lines.push("|-----------|----------|-------|---------|------|");
  for (const score of result.scores) {
    const pass = score.passed ? "Y" : "N";
    lines.push(`| ${score.name} | ${score.category} | ${score.score} | ${score.latencyMs}ms | ${pass} |`);
  }
  lines.push("");

  return lines.join("\n");
}

export function comparisonToMarkdown(comparison: ProviderComparison): string {
  const lines: string[] = [];
  lines.push("# Provider Comparison");
  lines.push("");
  lines.push(`**Winner:** ${comparison.winner}`);
  lines.push("");

  lines.push("## By Category");
  lines.push("");
  const catHeader = ["| Category |", ...comparison.providers.map((p) => ` ${p} |`)].join("");
  const catSep = ["|----------|", ...comparison.providers.map(() => "--------|")].join("");
  lines.push(catHeader);
  lines.push(catSep);

  const allCategories = new Set<string>();
  for (const provider of comparison.providers) {
    for (const cat of Object.keys(comparison.categoryTable[provider] ?? {})) {
      allCategories.add(cat);
    }
  }
  for (const cat of allCategories) {
    const row = [`| ${cat} |`];
    for (const provider of comparison.providers) {
      const val = comparison.categoryTable[provider]?.[cat];
      row.push(` ${val !== undefined ? val.toFixed(1) : "-"} |`);
    }
    lines.push(row.join(""));
  }
  lines.push("");

  lines.push("## By Benchmark");
  lines.push("");
  const benchHeader = ["| Benchmark |", ...comparison.providers.map((p) => ` ${p} |`)].join("");
  const benchSep = ["|-----------|", ...comparison.providers.map(() => "--------|")].join("");
  lines.push(benchHeader);
  lines.push(benchSep);

  for (const bench of comparison.benchmarks) {
    const row = [`| ${bench} |`];
    for (const provider of comparison.providers) {
      const val = comparison.table[provider]?.[bench];
      row.push(` ${val !== undefined ? String(val) : "-"} |`);
    }
    lines.push(row.join(""));
  }
  lines.push("");

  return lines.join("\n");
}

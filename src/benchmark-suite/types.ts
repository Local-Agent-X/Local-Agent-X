export type BenchmarkCategory =
  | "reasoning"
  | "coding"
  | "tool-use"
  | "creative"
  | "instruction-following"
  | "safety";

export interface Benchmark {
  name: string;
  category: BenchmarkCategory;
  prompt: string;
  expectedBehavior: string;
  timeout: number;
  validate: (response: string) => number;
}

export interface BenchmarkScore {
  name: string;
  category: BenchmarkCategory;
  score: number;
  latencyMs: number;
  response: string;
  passed: boolean;
}

export interface CategorySummary {
  category: BenchmarkCategory;
  avgScore: number;
  minScore: number;
  maxScore: number;
  count: number;
}

export interface BenchmarkRunResult {
  id: string;
  provider: string;
  model: string;
  timestamp: string;
  scores: BenchmarkScore[];
  categories: CategorySummary[];
  overallScore: number;
  totalDuration: number;
}

export interface ProviderComparison {
  providers: string[];
  benchmarks: string[];
  table: Record<string, Record<string, number>>;
  categoryTable: Record<string, Record<string, number>>;
  winner: string;
}

export type SendPromptFn = (prompt: string, provider?: string) => Promise<string>;

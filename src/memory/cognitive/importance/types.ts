export interface MemoryEntry {
  id: string;
  content: string;
  createdAt: number;
  lastAccessed?: number;
  accessCount?: number;
  userFeedback?: "positive" | "negative";
}

export interface ImportanceScore {
  score: number;
  factors: {
    recency: number;
    frequency: number;
    feedback: number;
    richness: number;
    emotional: number;
  };
  level: "critical" | "high" | "medium" | "low" | "archive";
}

export interface ArchiveResult {
  archived: string[];
  kept: string[];
  dryRun: boolean;
}

export interface ScoreRecord {
  memoryId: string;
  score: number;
  level: string;
  lastAccessed: number;
  accessCount: number;
  userFeedback: "positive" | "negative" | null;
  lastDecay: number;
}

export interface ScoresData {
  records: Record<string, ScoreRecord>;
  lastDecayRun: number;
}

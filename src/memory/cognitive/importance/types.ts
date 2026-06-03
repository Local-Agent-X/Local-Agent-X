export interface ImportanceScore {
  score: number;
  factors: {
    recency: number;
    reinforcement: number;
    confidence: number;
    richness: number;
    emotional: number;
  };
  level: "critical" | "high" | "medium" | "low" | "archive";
}

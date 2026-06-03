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

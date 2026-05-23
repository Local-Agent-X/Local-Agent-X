import type { ImportanceScore } from "./types.js";
import {
  EMOTION_KEYWORDS,
  MS_PER_DAY,
  RECENCY_HALF_LIFE_DAYS,
  WEIGHTS,
} from "./constants.js";

export function calcRichness(content: string): number {
  const length = content.length;
  const lengthScore = Math.min(100, (length / 5000) * 100);

  const entities =
    (content.match(/@\w+/g)?.length || 0) +
    (content.match(/\[\[.+?\]\]/g)?.length || 0) +
    (content.match(/^#{1,3}\s/gm)?.length || 0) +
    (content.match(/https?:\/\/\S+/g)?.length || 0);
  const entityScore = Math.min(100, entities * 10);

  return (lengthScore * 0.6 + entityScore * 0.4);
}

export function calcEmotional(content: string): number {
  const lower = content.toLowerCase();
  let hits = 0;
  for (const kw of EMOTION_KEYWORDS) {
    if (lower.includes(kw)) hits++;
  }
  return Math.min(100, 20 + hits * 16);
}

export function scoreToLevel(score: number): "critical" | "high" | "medium" | "low" | "archive" {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  if (score >= 15) return "low";
  return "archive";
}

export function scoreMemory(memory: {
  content: string;
  createdAt: number;
  lastAccessed?: number;
  accessCount?: number;
  userFeedback?: "positive" | "negative";
}): ImportanceScore {
  const now = Date.now();

  const referenceTime = memory.lastAccessed || memory.createdAt;
  const daysSince = Math.max(0, (now - referenceTime) / MS_PER_DAY);
  const recency = Math.pow(0.5, daysSince / RECENCY_HALF_LIFE_DAYS) * 100;

  const rawFreq = Math.log(Math.max(0, memory.accessCount || 0) + 1);
  const maxFreq = Math.log(101);
  const frequency = Math.min(100, (rawFreq / maxFreq) * 100);

  let feedback = 50;
  if (memory.userFeedback === "positive") feedback = 100;
  else if (memory.userFeedback === "negative") feedback = 10;

  const richness = calcRichness(memory.content);
  const emotional = calcEmotional(memory.content);

  const score = Math.round(
    WEIGHTS.recency * recency +
    WEIGHTS.frequency * frequency +
    WEIGHTS.feedback * feedback +
    WEIGHTS.richness * richness +
    WEIGHTS.emotional * emotional
  );

  const clampedScore = Math.max(0, Math.min(100, score));

  return {
    score: clampedScore,
    factors: {
      recency: Math.round(recency * 10) / 10,
      frequency: Math.round(frequency * 10) / 10,
      feedback,
      richness: Math.round(richness * 10) / 10,
      emotional: Math.round(emotional * 10) / 10,
    },
    level: scoreToLevel(clampedScore),
  };
}

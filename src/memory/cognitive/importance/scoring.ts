import type { RetainedFact } from "../../types.js";
import type { ImportanceScore } from "./types.js";
import {
  EMOTION_KEYWORDS,
  MS_PER_DAY,
  RECENCY_HALF_LIFE_DAYS,
  WEIGHTS,
} from "./constants.js";

export function calcRichness(content: string, entityCount: number): number {
  // Facts are short atomic statements, not the long markdown documents this
  // scorer was first written for. Scale length to a fact-realistic ceiling and
  // lean on the entity tags the facts DB already extracted, rather than
  // regex-scanning the body for @mentions / [[links]] that facts rarely carry.
  const lengthScore = Math.min(100, (content.length / 300) * 100);
  const entityScore = Math.min(100, entityCount * 25);
  return lengthScore * 0.5 + entityScore * 0.5;
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

export function scoreFact(fact: RetainedFact, now: number): ImportanceScore {
  // Recency anchors on the immutable creation `timestamp`, never `lastUpdated`.
  // reinforceFacts() bumps lastUpdated on re-mention, and letting that drive
  // recency made old biographical facts re-render as "fresh" — see
  // memory/context.test.ts.
  const daysSince = Math.max(0, (now - fact.timestamp) / MS_PER_DAY);
  const recency = Math.pow(0.5, daysSince / RECENCY_HALF_LIFE_DAYS) * 100;

  // The facts DB has no access counter; the only "mentioned again" signal is
  // lastUpdated pulling ahead of the creation timestamp (reinforceFacts), so
  // reinforcement is binary: has this fact been re-mentioned since it landed.
  const reinforcement = fact.lastUpdated > fact.timestamp ? 100 : 0;

  // Confidence stands in for the user-feedback term the original formula
  // expected — it is the trust signal facts actually carry (0..1).
  const confidence = Math.max(0, Math.min(100, fact.confidence * 100));

  const richness = calcRichness(fact.content, fact.entities.length);
  const emotional = calcEmotional(fact.content);

  const score = Math.round(
    WEIGHTS.recency * recency +
    WEIGHTS.reinforcement * reinforcement +
    WEIGHTS.confidence * confidence +
    WEIGHTS.richness * richness +
    WEIGHTS.emotional * emotional
  );

  const clampedScore = Math.max(0, Math.min(100, score));

  return {
    score: clampedScore,
    factors: {
      recency: Math.round(recency * 10) / 10,
      reinforcement,
      confidence: Math.round(confidence * 10) / 10,
      richness: Math.round(richness * 10) / 10,
      emotional: Math.round(emotional * 10) / 10,
    },
    level: scoreToLevel(clampedScore),
  };
}

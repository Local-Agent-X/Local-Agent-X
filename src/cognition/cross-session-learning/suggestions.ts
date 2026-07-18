import { createHash } from "node:crypto";
import type {
  ActionEntry,
  AutomationSuggestion,
  CandidateEvidenceSnapshot,
  DetectedPattern,
  LearnedCandidate,
  LearnedCandidateState,
  SessionInsight,
} from "./types.js";
import { MS_PER_DAY, REJECTION_COOLDOWN_DAYS } from "./types.js";
import { slugify } from "./text-utils.js";

const TRANSITIONS: Record<LearnedCandidateState, LearnedCandidateState[]> = {
  candidate: ["approved", "rejected", "archived"],
  approved: ["active", "rejected", "archived"],
  active: ["archived", "rolled-back"],
  rejected: ["candidate", "archived"],
  archived: ["candidate"],
  "rolled-back": ["archived", "candidate"],
};

function identityFor(pattern: DetectedPattern): string {
  const description = pattern.description.trim().toLowerCase();
  let anchor: string;
  switch (pattern.type) {
    case "workflow":
    case "question":
    case "task":
    case "topic":
      anchor = description.match(/"([^"]+)"/)?.[1]
        ?? pattern.examples[0]?.trim().toLowerCase()
        ?? description;
      break;
    case "time":
      anchor = description.replace(/ \(\d+ times\)$/, "");
      break;
  }
  return JSON.stringify([pattern.type, anchor]);
}

export function candidateIdFor(pattern: DetectedPattern): string {
  return `learned-${createHash("sha256").update(identityFor(pattern)).digest("hex").slice(0, 20)}`;
}

export function confidenceFor(pattern: DetectedPattern): number {
  if (pattern.outcomeStats) {
    const sessionFactor = Math.min(1, pattern.outcomeStats.distinctSessions / 3);
    return Math.round(pattern.outcomeStats.weightedSuccessRate * sessionFactor * 1000) / 1000;
  }
  return Math.round(Math.min(1, pattern.occurrences / 10) * 1000) / 1000;
}

function snapshot(pattern: DetectedPattern): CandidateEvidenceSnapshot {
  return {
    patternType: pattern.type,
    description: pattern.description,
    occurrences: pattern.occurrences,
    lastSeen: pattern.lastSeen,
    examples: [...pattern.examples],
    ...(pattern.outcomeStats ? { outcomeStats: { ...pattern.outcomeStats } } : {}),
  };
}

export function createLearnedCandidate(
  pattern: DetectedPattern,
  suggestion: AutomationSuggestion,
  now = Date.now(),
): LearnedCandidate {
  return {
    id: candidateIdFor(pattern),
    state: "candidate",
    confidence: confidenceFor(pattern),
    suggestion: structuredClone(suggestion),
    evidence: snapshot(pattern),
    createdAt: now,
    updatedAt: now,
    transitions: [],
  };
}

export function transitionCandidate(
  candidate: LearnedCandidate,
  to: LearnedCandidateState,
  now = Date.now(),
  reason?: string,
): LearnedCandidate {
  if (now < candidate.updatedAt) {
    throw new Error(`Learned candidate transition predates current state: ${candidate.id}`);
  }
  if (!TRANSITIONS[candidate.state].includes(to)) {
    throw new Error(`Invalid learned candidate transition: ${candidate.state} -> ${to}`);
  }
  return {
    ...candidate,
    state: to,
    updatedAt: now,
    ...(to === "rejected"
      ? { rejectionCooldownUntil: now + REJECTION_COOLDOWN_DAYS * MS_PER_DAY }
      : { rejectionCooldownUntil: undefined }),
    transitions: [
      ...candidate.transitions,
      { from: candidate.state, to, timestamp: now, ...(reason ? { reason } : {}) },
    ],
  };
}

export function suggestAutomation(
  pattern: DetectedPattern
): AutomationSuggestion | null {
  if (pattern.automationEligible === false) return null;
  switch (pattern.type) {
    case "question":
      return {
        type: "shortcut",
        name: `auto-answer-${slugify(pattern.description.slice(0, 40))}`,
        description: `You've asked this ${pattern.occurrences} times — want me to remember the answer?`,
        config: {
          trigger: pattern.examples[0] || pattern.description,
          patternType: "question",
          occurrences: pattern.occurrences,
        },
      };

    case "task":
      return {
        type: "mission",
        name: `auto-task-${slugify(pattern.description.slice(0, 40))}`,
        description: `You've done this ${pattern.occurrences} times — want me to make this a mission?`,
        config: {
          steps: pattern.examples,
          patternType: "task",
          occurrences: pattern.occurrences,
        },
      };

    case "time":
      return {
        type: "cron",
        name: `scheduled-${slugify(pattern.description.slice(0, 40))}`,
        description: `This happens regularly at the same time — want me to set up a cron job?`,
        config: {
          schedule: pattern.suggestedAction || "",
          patternType: "time",
          occurrences: pattern.occurrences,
        },
      };

    case "topic":
      return {
        type: "shortcut",
        name: `topic-${slugify(pattern.description.slice(0, 40))}`,
        description: `This topic comes up often — want me to add it to your briefing?`,
        config: {
          topic: pattern.description,
          patternType: "topic",
          occurrences: pattern.occurrences,
        },
      };

    case "workflow":
      return {
        type: "mission",
        name: `workflow-${slugify(pattern.description.slice(0, 40))}`,
        description: `This sequence repeats often — want me to bundle it into a mission?`,
        config: {
          sequence: pattern.examples,
          patternType: "workflow",
          occurrences: pattern.occurrences,
        },
      };

    default:
      return {
        type: "shortcut",
        name: `pattern-${Date.now()}`,
        description: `Detected pattern: ${pattern.description}`,
        config: { raw: pattern },
      };
  }
}

export function getInsights(actions: ActionEntry[]): SessionInsight[] {
  const insights: SessionInsight[] = [];
  const now = Date.now();

  const weekActions = actions.filter(
    (a) => now - a.timestamp < 7 * MS_PER_DAY
  );
  const taskFreq = new Map<string, number>();
  for (const a of weekActions) {
    taskFreq.set(a.type, (taskFreq.get(a.type) || 0) + 1);
  }
  const topTasks = Array.from(taskFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (topTasks.length > 0) {
    insights.push({
      type: "common_tasks",
      description: `Top tasks this week: ${topTasks.map(([t, c]) => `${t} (${c}x)`).join(", ")}`,
      data: Object.fromEntries(topTasks),
      period: "weekly",
    });
  }

  const hourCounts = new Array(24).fill(0);
  for (const a of weekActions) {
    hourCounts[new Date(a.timestamp).getHours()]++;
  }
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  if (weekActions.length > 0) {
    insights.push({
      type: "peak_hours",
      description: `Most active hour this week: ${peakHour.toString().padStart(2, "0")}:00 (${hourCounts[peakHour]} actions)`,
      data: { peakHour, distribution: hourCounts },
      period: "weekly",
    });
  }

  const todayActions = actions.filter(
    (a) => now - a.timestamp < MS_PER_DAY
  );
  const todaySessions = new Set(todayActions.map((a) => a.sessionId)).size;
  insights.push({
    type: "daily_sessions",
    description: `${todaySessions} session(s) today with ${todayActions.length} total actions`,
    data: { sessions: todaySessions, actions: todayActions.length },
    period: "daily",
  });

  const monthActions = actions.filter(
    (a) => now - a.timestamp < 30 * MS_PER_DAY
  );
  const weeklyBuckets: number[] = [0, 0, 0, 0];
  for (const a of monthActions) {
    const weeksAgo = Math.floor((now - a.timestamp) / (7 * MS_PER_DAY));
    if (weeksAgo < 4) weeklyBuckets[weeksAgo]++;
  }
  insights.push({
    type: "monthly_trend",
    description: `Activity trend (recent to oldest week): ${weeklyBuckets.join(", ")} actions`,
    data: { weeklyBuckets },
    period: "monthly",
  });

  return insights;
}

import type {
  ActionEntry,
  AutomationSuggestion,
  CandidateEvidenceSnapshot,
  DetectedPattern,
  LearnedCandidate,
  LearnedCandidateState,
  SessionInsight,
} from "./types.js";
import {
  hasCandidateEvidenceIdentity,
  CANDIDATE_TRANSITIONS,
  deriveCandidateId,
  hasEvidenceIdentity,
  isExactTerminalTelemetryAction,
  isExactWorkflowTacticAction,
  hasPatternEvidenceIdentity,
  MS_PER_DAY,
  REJECTION_COOLDOWN_DAYS,
  WORKFLOW_TACTIC_IDENTITY,
} from "./types.js";
import { slugify } from "./text-utils.js";

export function candidateIdFor(pattern: DetectedPattern): string {
  return deriveCandidateId(pattern.type, pattern.description, pattern.examples);
}

export function confidenceFor(pattern: DetectedPattern): number {
  if (pattern.outcomeStats) {
    const sessionFactor = Math.min(1, pattern.outcomeStats.distinctSessions / 3);
    return Math.round(pattern.outcomeStats.weightedSuccessRate * sessionFactor * 1000) / 1000;
  }
  return Math.round(Math.min(1, pattern.occurrences / 10) * 1000) / 1000;
}

function snapshot(pattern: DetectedPattern): CandidateEvidenceSnapshot {
  if (!hasPatternEvidenceIdentity(pattern)) {
    throw new Error("Learned pattern has mismatched evidence authority");
  }
  return {
    evidenceClass: pattern.sourceEvidence!.evidenceClass,
    authority: pattern.sourceEvidence!.authority,
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
  if (!hasPatternEvidenceIdentity(pattern)) {
    throw new Error("Learned pattern has mismatched evidence authority");
  }
  return {
    ...WORKFLOW_TACTIC_IDENTITY,
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
  if (!hasCandidateEvidenceIdentity(candidate)) {
    throw new Error("Learned candidate has mismatched evidence authority");
  }
  if (now < candidate.updatedAt) {
    throw new Error(`Learned candidate transition predates current state: ${candidate.id}`);
  }
  if (!CANDIDATE_TRANSITIONS[candidate.state].includes(to)) {
    throw new Error(`Invalid learned candidate transition: ${candidate.state} -> ${to}`);
  }
  const { rejectionCooldownUntil: _cooldown, ...base } = candidate;
  return {
    ...base,
    state: to,
    updatedAt: now,
    ...(to === "rejected"
      ? { rejectionCooldownUntil: now + REJECTION_COOLDOWN_DAYS * MS_PER_DAY }
      : {}),
    transitions: [
      ...candidate.transitions,
      { from: candidate.state, to, timestamp: now, ...(reason ? { reason } : {}) },
    ],
  };
}

export function suggestAutomation(
  pattern: DetectedPattern
): AutomationSuggestion | null {
  if (!hasEvidenceIdentity(pattern, WORKFLOW_TACTIC_IDENTITY) || !hasPatternEvidenceIdentity(pattern)) return null;
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
  actions = actions.filter((action) =>
    isExactWorkflowTacticAction(action) || isExactTerminalTelemetryAction(action)
  );
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

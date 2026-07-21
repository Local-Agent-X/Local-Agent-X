import type { ActionEntry, DetectedPattern } from "./types.js";
import {
  isExactTerminalTelemetryAction,
  isExactWorkflowTacticAction,
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
} from "./types.js";
import {
  clusterBySimilarity,
  extractKeywords,
  normalizeDetail,
} from "./text-utils.js";

function asWorkflowTactics(
  patterns: DetectedPattern[],
  sourceEvidence: typeof WORKFLOW_TACTIC_IDENTITY | typeof TERMINAL_TELEMETRY_IDENTITY,
): DetectedPattern[] {
  return patterns.map((pattern) => ({ ...WORKFLOW_TACTIC_IDENTITY, sourceEvidence, ...pattern }));
}

export function detectRepeatedQuestions(
  actions: ActionEntry[],
  min: number
): DetectedPattern[] {
  const questions = actions.filter((a) =>
    isExactWorkflowTacticAction(a) && a.type === "question"
  );
  const clusters = clusterBySimilarity(
    questions.map((q) => q.details),
    0.6
  );

  return asWorkflowTactics(clusters
    .filter((c) => c.items.length >= min)
    .map((c) => ({
      type: "question" as const,
      description: `Question asked ${c.items.length} times: "${c.representative}"`,
      occurrences: c.items.length,
      lastSeen: Math.max(
        ...questions
          .filter((q) => c.items.includes(q.details))
          .map((q) => q.timestamp)
      ),
      examples: c.items.slice(0, 5),
      suggestedAction: `Create a shortcut or FAQ entry for: "${c.representative}"`,
    })), WORKFLOW_TACTIC_IDENTITY);
}

export function detectRepeatedTasks(
  actions: ActionEntry[],
  min: number
): DetectedPattern[] {
  const tasks = actions.filter(
    (a) => isExactWorkflowTacticAction(a)
      && (a.type === "tool_call" || a.type === "task")
  );
  const taskCounts = new Map<
    string,
    { count: number; last: number; examples: string[] }
  >();

  for (const t of tasks) {
    const key = normalizeDetail(t.details);
    const existing = taskCounts.get(key);
    if (existing) {
      existing.count++;
      existing.last = Math.max(existing.last, t.timestamp);
      if (existing.examples.length < 5) existing.examples.push(t.details);
    } else {
      taskCounts.set(key, {
        count: 1,
        last: t.timestamp,
        examples: [t.details],
      });
    }
  }

  return asWorkflowTactics(Array.from(taskCounts.entries())
    .filter(([, v]) => v.count >= min)
    .map(([key, v]) => ({
      type: "task" as const,
      description: `Task performed ${v.count} times: "${key}"`,
      occurrences: v.count,
      lastSeen: v.last,
      examples: v.examples,
      suggestedAction: `Create a mission template for: "${key}"`,
    })), WORKFLOW_TACTIC_IDENTITY);
}

export function detectRepeatedTopics(
  actions: ActionEntry[],
  min: number
): DetectedPattern[] {
  actions = actions.filter((action) =>
    isExactWorkflowTacticAction(action) && action.type !== "op_outcome"
  );
  const sessionTopics = new Map<string, Set<string>>();

  for (const a of actions) {
    if (!sessionTopics.has(a.sessionId)) {
      sessionTopics.set(a.sessionId, new Set());
    }
    const words = extractKeywords(a.details);
    for (const w of words) {
      sessionTopics.get(a.sessionId)!.add(w);
    }
  }

  const keywordSessions = new Map<string, Set<string>>();
  for (const [sessId, words] of sessionTopics) {
    for (const w of words) {
      if (!keywordSessions.has(w)) keywordSessions.set(w, new Set());
      keywordSessions.get(w)!.add(sessId);
    }
  }

  return asWorkflowTactics(Array.from(keywordSessions.entries())
    .filter(([, sessions]) => sessions.size >= min)
    .map(([keyword, sessions]) => ({
      type: "topic" as const,
      description: `Topic "${keyword}" discussed across ${sessions.size} sessions`,
      occurrences: sessions.size,
      lastSeen: Math.max(
        ...actions
          .filter((a) => a.details.toLowerCase().includes(keyword))
          .map((a) => a.timestamp),
        0
      ),
      examples: Array.from(sessions).slice(0, 5),
    })), WORKFLOW_TACTIC_IDENTITY);
}

export function detectTimePatterns(
  actions: ActionEntry[],
  min: number
): DetectedPattern[] {
  actions = actions.filter((action) =>
    isExactWorkflowTacticAction(action) && action.type !== "op_outcome"
  );
  const hourBuckets = new Map<
    number,
    { count: number; types: Map<string, number> }
  >();

  for (const a of actions) {
    const hour = new Date(a.timestamp).getHours();
    if (!hourBuckets.has(hour)) {
      hourBuckets.set(hour, { count: 0, types: new Map() });
    }
    const bucket = hourBuckets.get(hour)!;
    bucket.count++;
    bucket.types.set(a.type, (bucket.types.get(a.type) || 0) + 1);
  }

  const patterns: DetectedPattern[] = [];

  for (const [hour, bucket] of hourBuckets) {
    for (const [actionType, count] of bucket.types) {
      if (count >= min) {
        const timeStr = `${hour.toString().padStart(2, "0")}:00`;
        patterns.push({
          type: "time",
          description: `"${actionType}" often happens around ${timeStr} (${count} times)`,
          occurrences: count,
          lastSeen: Math.max(
            ...actions
              .filter(
                (a) =>
                  a.type === actionType &&
                  new Date(a.timestamp).getHours() === hour
              )
              .map((a) => a.timestamp),
            0
          ),
          examples: [`${actionType} at ${timeStr}`],
          suggestedAction: `Set up a cron job for "${actionType}" at ${timeStr}`,
        });
      }
    }
  }

  return asWorkflowTactics(patterns, WORKFLOW_TACTIC_IDENTITY);
}

export function detectWorkflowPatterns(
  actions: ActionEntry[],
  min: number
): DetectedPattern[] {
  const outcomePatterns = detectOutcomeWorkflows(actions, min);
  const legacyActions = actions.filter((action) =>
    isExactWorkflowTacticAction(action) && action.type !== "op_outcome"
  );
  const sessionActions = new Map<string, ActionEntry[]>();
  for (const a of legacyActions) {
    if (!sessionActions.has(a.sessionId)) {
      sessionActions.set(a.sessionId, []);
    }
    sessionActions.get(a.sessionId)!.push(a);
  }

  for (const list of sessionActions.values()) {
    list.sort((a, b) => a.timestamp - b.timestamp);
  }

  const sequenceCounts = new Map<
    string,
    { count: number; last: number; steps: string[] }
  >();

  for (const list of sessionActions.values()) {
    for (let windowSize = 2; windowSize <= 4; windowSize++) {
      for (let i = 0; i <= list.length - windowSize; i++) {
        const seq = list.slice(i, i + windowSize);
        const key = seq.map((a) => a.type).join(" -> ");
        const existing = sequenceCounts.get(key);
        if (existing) {
          existing.count++;
          existing.last = Math.max(
            existing.last,
            seq[seq.length - 1].timestamp
          );
        } else {
          sequenceCounts.set(key, {
            count: 1,
            last: seq[seq.length - 1].timestamp,
            steps: seq.map((a) => a.type),
          });
        }
      }
    }
  }

  const legacyPatterns = Array.from(sequenceCounts.entries())
    .filter(([, v]) => v.count >= min)
    .map(([key, v]) => ({
      type: "workflow" as const,
      description: `Workflow "${key}" repeated ${v.count} times`,
      occurrences: v.count,
      lastSeen: v.last,
      examples: [key],
      suggestedAction: `Bundle "${key}" into a single mission or shortcut`,
    }));
  return [...outcomePatterns, ...asWorkflowTactics(legacyPatterns, WORKFLOW_TACTIC_IDENTITY)];
}

function detectOutcomeWorkflows(actions: ActionEntry[], min: number): DetectedPattern[] {
  const groups = new Map<string, {
    category: NonNullable<ActionEntry["category"]>;
    tools: string[];
    entries: ActionEntry[];
  }>();
  for (const action of actions) {
    if (!isExactTerminalTelemetryAction(action)) continue;
    const key = JSON.stringify([action.category, action.tools]);
    const group = groups.get(key);
    if (group) group.entries.push(action);
    else groups.set(key, { category: action.category, tools: action.tools, entries: [action] });
  }

  const patterns: DetectedPattern[] = [];
  for (const group of groups.values()) {
    if (group.entries.length < min) continue;
    const clean = group.entries.filter((entry) => entry.outcome === "clean").length;
    const partial = group.entries.filter((entry) => entry.outcome === "partial").length;
    const aborted = group.entries.filter((entry) => entry.outcome === "aborted").length;
    const successRate = clean / group.entries.length;
    const latest = Math.max(...group.entries.map((entry) => entry.timestamp));
    const halfLifeMs = 14 * 24 * 60 * 60 * 1000;
    let cleanWeight = 0;
    let totalWeight = 0;
    for (const entry of group.entries) {
      const weight = Math.exp(-(latest - entry.timestamp) / halfLifeMs);
      totalWeight += weight;
      if (entry.outcome === "clean") cleanWeight += weight;
    }
    const weightedSuccessRate = totalWeight > 0 ? cleanWeight / totalWeight : 0;
    const distinctSessions = new Set(
      group.entries.map((entry) => entry.sessionId).filter(Boolean)
    ).size;
    const automationEligible = group.tools.length > 0
      && clean >= min
      && successRate >= 0.75
      && weightedSuccessRate >= 0.75
      && distinctSessions >= 2;
    const label = `${group.category}:${group.tools.join(" -> ") || "no-tools"}`;
    patterns.push({
      type: "workflow",
      description: `Workflow "${label}" completed cleanly ${clean}/${group.entries.length} times`,
      occurrences: group.entries.length,
      lastSeen: latest,
      examples: [group.tools.join(" -> ") || "no-tools"],
      suggestedAction: automationEligible
        ? `Bundle "${label}" into a reusable workflow`
        : `Review "${label}" before automation because its evidence is not yet reliable`,
      automationEligible,
      outcomeStats: { clean, partial, aborted, successRate, weightedSuccessRate, distinctSessions },
    });
  }
  return asWorkflowTactics(patterns, TERMINAL_TELEMETRY_IDENTITY);
}

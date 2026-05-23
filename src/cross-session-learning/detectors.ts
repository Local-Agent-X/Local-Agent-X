import type { ActionEntry, DetectedPattern } from "./types.js";
import {
  clusterBySimilarity,
  extractKeywords,
  normalizeDetail,
} from "./text-utils.js";

export function detectRepeatedQuestions(
  actions: ActionEntry[],
  min: number
): DetectedPattern[] {
  const questions = actions.filter((a) => a.type === "question");
  const clusters = clusterBySimilarity(
    questions.map((q) => q.details),
    0.6
  );

  return clusters
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
    }));
}

export function detectRepeatedTasks(
  actions: ActionEntry[],
  min: number
): DetectedPattern[] {
  const tasks = actions.filter(
    (a) => a.type === "tool_call" || a.type === "task"
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

  return Array.from(taskCounts.entries())
    .filter(([, v]) => v.count >= min)
    .map(([key, v]) => ({
      type: "task" as const,
      description: `Task performed ${v.count} times: "${key}"`,
      occurrences: v.count,
      lastSeen: v.last,
      examples: v.examples,
      suggestedAction: `Create a mission template for: "${key}"`,
    }));
}

export function detectRepeatedTopics(
  actions: ActionEntry[],
  min: number
): DetectedPattern[] {
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

  return Array.from(keywordSessions.entries())
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
    }));
}

export function detectTimePatterns(
  actions: ActionEntry[],
  min: number
): DetectedPattern[] {
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

  return patterns;
}

export function detectWorkflowPatterns(
  actions: ActionEntry[],
  min: number
): DetectedPattern[] {
  const sessionActions = new Map<string, ActionEntry[]>();
  for (const a of actions) {
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

  return Array.from(sequenceCounts.entries())
    .filter(([, v]) => v.count >= min)
    .map(([key, v]) => ({
      type: "workflow" as const,
      description: `Workflow "${key}" repeated ${v.count} times`,
      occurrences: v.count,
      lastSeen: v.last,
      examples: [key],
      suggestedAction: `Bundle "${key}" into a single mission or shortcut`,
    }));
}

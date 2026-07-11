import type {
  ActionEntry,
  AutomationSuggestion,
  DetectedPattern,
  SessionInsight,
} from "./types.js";
import { MS_PER_DAY } from "./types.js";
import { slugify } from "./text-utils.js";

export function suggestAutomation(
  pattern: DetectedPattern
): AutomationSuggestion {
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

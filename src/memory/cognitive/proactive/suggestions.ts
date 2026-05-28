import type { PatternsFile, ProactiveSuggestion } from "./types.js";
import { extractTopics } from "./text-utils.js";
import { isLateNight, isWeekend } from "./time-utils.js";

export function getTimeSuggestions(data: PatternsFile, hour: number): string[] {
  const hints: string[] = [];

  if (isLateNight(hour)) {
    const lateInteractions = data.interactions.filter((i) => {
      const h = new Date(i.timestamp).getHours();
      return h >= 23 || h < 5;
    });
    if (lateInteractions.length > 5) {
      hints.push("You seem to work late fairly often. Remember to take breaks when you need them.");
    } else {
      hints.push("It's getting late. Let me know if you want to wrap up and pick this up tomorrow.");
    }
  }

  const hourInteractions = data.interactions.filter((i) => {
    const h = new Date(i.timestamp).getHours();
    return h === hour;
  });
  if (hourInteractions.length >= 5) {
    const topicFreq: Record<string, number> = {};
    for (const interaction of hourInteractions) {
      for (const t of interaction.topics) {
        topicFreq[t] = (topicFreq[t] || 0) + 1;
      }
    }
    const sorted = Object.entries(topicFreq).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0 && sorted[0][1] >= 3) {
      hints.push(`Around this time you often work on "${sorted[0][0]}".`);
    }
  }

  if (isWeekend()) {
    const weekendCount = data.interactions.filter((i) => {
      const d = new Date(i.timestamp).getDay();
      return d === 0 || d === 6;
    }).length;
    if (weekendCount > 10) {
      // User works weekends regularly, no need to comment
    } else if (weekendCount > 0) {
      hints.push("Weekend session — let me know if you want to keep things light.");
    }
  }

  return hints;
}

export function getTopicSuggestions(data: PatternsFile, topic: string): string[] {
  const hints: string[] = [];
  const related = data.topicIndex[topic];

  if (related && related.length > 0) {
    const freq: Record<string, number> = {};
    for (const t of related) {
      freq[t] = (freq[t] || 0) + 1;
    }
    const sorted = Object.entries(freq)
      .filter(([t]) => t !== topic)
      .sort((a, b) => b[1] - a[1]);

    if (sorted.length > 0 && sorted[0][1] >= 2) {
      hints.push(
        `When you've worked on "${topic}" before, you also tended to look at "${sorted[0][0]}".`,
      );
    }
  }

  return hints;
}

export function getPatternAlerts(data: PatternsFile): string[] {
  const alerts: string[] = [];
  for (const pattern of data.patterns) {
    if (pattern.confidence >= 0.7 && pattern.frequency >= 3) {
      alerts.push(pattern.response);
    }
  }
  return alerts.slice(0, 5);
}

export function analyzeContext(
  data: PatternsFile,
  currentMessage: string,
  recentMessages: Array<{ role: string; content: string }>,
  timeOfDay: number,
): ProactiveSuggestion[] {
  const suggestions: ProactiveSuggestion[] = [];
  const currentTopics = extractTopics(currentMessage);
  const hour = timeOfDay;

  // 1) Time-based patterns
  for (const hint of getTimeSuggestions(data, hour)) {
    suggestions.push({
      type: "time",
      message: hint,
      confidence: 0.6,
      source: "time-pattern",
    });
  }

  // 2) Topic-based: "last time you mentioned this, you also needed Y"
  for (const topic of currentTopics) {
    for (const hint of getTopicSuggestions(data, topic)) {
      suggestions.push({
        type: "topic",
        message: hint,
        confidence: 0.5,
        source: `topic:${topic}`,
      });
    }
  }

  // 3) Behavioral patterns: repeated questions
  const recentTexts = recentMessages.map((m) => m.content.toLowerCase());
  const thisWeek = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentInteractions = data.interactions.filter((i) => i.timestamp > thisWeek);

  for (const topic of currentTopics) {
    const freq = recentInteractions.filter((i) =>
      i.topics.includes(topic),
    ).length;
    if (freq >= 3) {
      suggestions.push({
        type: "behavioral",
        message: `You've asked about "${topic}" ${freq} times this week. Want me to compile a reference or set up a shortcut?`,
        confidence: Math.min(0.9, 0.5 + freq * 0.1),
        source: `frequency:${topic}`,
      });
    }
  }

  // 4) Emotional patterns from stored patterns
  for (const pattern of data.patterns) {
    if (pattern.type === "emotional") {
      if (currentTopics.some((t) => pattern.trigger.includes(t))) {
        suggestions.push({
          type: "emotional",
          message: pattern.response,
          confidence: pattern.confidence,
          source: `emotional-pattern:${pattern.trigger}`,
        });
      }
    }
  }

  // 5) Incomplete tasks: look for "todo", "need to", "should" in past interactions
  // that haven't been followed up on
  const taskKeywords = ["need to", "should", "todo", "want to", "plan to", "going to"];
  for (const interaction of recentInteractions) {
    const msgLower = interaction.message.toLowerCase();
    for (const kw of taskKeywords) {
      if (msgLower.includes(kw)) {
        const idx = msgLower.indexOf(kw);
        const taskFragment = interaction.message.slice(idx, idx + 80).trim();
        const referenced = recentTexts.some((rt) =>
          interaction.topics.some((t) => rt.includes(t)),
        );
        if (!referenced && currentTopics.some((t) => interaction.topics.includes(t))) {
          suggestions.push({
            type: "task",
            message: `You previously mentioned: "${taskFragment}" — still on your list?`,
            confidence: 0.4,
            source: `incomplete-task:${interaction.timestamp}`,
          });
          break; // One task suggestion per interaction
        }
      }
    }
  }

  const seen = new Set<string>();
  const unique = suggestions.filter((s) => {
    if (seen.has(s.message)) return false;
    seen.add(s.message);
    return true;
  });

  return unique.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

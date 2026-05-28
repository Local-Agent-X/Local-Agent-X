import type { InteractionPattern, PatternsFile } from "./types.js";

export function learnPattern(data: PatternsFile, pattern: InteractionPattern): void {
  const existing = data.patterns.find(
    (p) => p.type === pattern.type && p.trigger === pattern.trigger,
  );
  if (existing) {
    existing.frequency += 1;
    existing.lastSeen = Date.now();
    existing.confidence = Math.min(1, existing.confidence + 0.05);
    existing.response = pattern.response;
  } else {
    data.patterns.push({ ...pattern, lastSeen: Date.now() });
  }
}

export function detectBehavioralPatterns(
  data: PatternsFile,
  currentTopics: string[],
  timestamp: number,
): void {
  const hour = new Date(timestamp).getHours();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const recent = data.interactions.filter((i) => timestamp - i.timestamp < oneWeek);

  for (const topic of currentTopics) {
    const atSameHour = recent.filter((i) => {
      const h = new Date(i.timestamp).getHours();
      return Math.abs(h - hour) <= 1 && i.topics.includes(topic);
    });
    if (atSameHour.length >= 3) {
      const timeLabel = hour < 12 ? "mornings" : hour < 17 ? "afternoons" : "evenings";
      learnPattern(data, {
        type: "time",
        trigger: `${topic}@${hour}`,
        response: `You tend to work on "${topic}" in the ${timeLabel}.`,
        frequency: atSameHour.length,
        lastSeen: timestamp,
        confidence: Math.min(0.9, 0.4 + atSameHour.length * 0.1),
      });
    }
  }
}

export function updateTopicIndex(data: PatternsFile, topics: string[]): void {
  for (let i = 0; i < topics.length; i++) {
    if (!data.topicIndex[topics[i]]) {
      data.topicIndex[topics[i]] = [];
    }
    for (let j = 0; j < topics.length; j++) {
      if (i !== j) {
        data.topicIndex[topics[i]].push(topics[j]);
      }
    }
    // Cap per-topic associations to keep the index bounded
    if (data.topicIndex[topics[i]].length > 50) {
      data.topicIndex[topics[i]] = data.topicIndex[topics[i]].slice(-50);
    }
  }
}

import type { InteractionPattern, PatternsFile, ProactiveSuggestion } from "./types.js";
import { loadPatterns, savePatterns } from "./persistence.js";
import { extractTopics } from "./text-utils.js";
import {
  analyzeContext,
  getPatternAlerts,
  getTimeSuggestions,
  getTopicSuggestions,
} from "./suggestions.js";
import { detectBehavioralPatterns, learnPattern as recordPattern, updateTopicIndex } from "./detectors.js";

class ProactiveMemoryImpl {
  private data: PatternsFile;

  constructor() {
    this.data = loadPatterns();
  }

  /** Analyze the current context and return proactive suggestions. */
  analyzeContext(
    currentMessage: string,
    recentMessages: Array<{ role: string; content: string }>,
    timeOfDay: number,
  ): ProactiveSuggestion[] {
    return analyzeContext(this.data, currentMessage, recentMessages, timeOfDay);
  }

  /** Get time-of-day suggestions based on the hour and historical patterns. */
  getTimeSuggestions(hour: number): string[] {
    return getTimeSuggestions(this.data, hour);
  }

  /** Get suggestions based on topic associations from past interactions. */
  getTopicSuggestions(topic: string): string[] {
    return getTopicSuggestions(this.data, topic);
  }

  /** Get alerts about recurring patterns worth surfacing. */
  getPatternAlerts(): string[] {
    return getPatternAlerts(this.data);
  }

  /** Record a user interaction for pattern learning. */
  recordInteraction(sessionId: string, message: string, timestamp: number): void {
    const topics = extractTopics(message);

    this.data.interactions.push({ sessionId, message: message.slice(0, 300), timestamp, topics });

    updateTopicIndex(this.data, topics);
    detectBehavioralPatterns(this.data, topics, timestamp);

    savePatterns(this.data);
  }

  /** Manually register a learned pattern. */
  learnPattern(pattern: InteractionPattern): void {
    recordPattern(this.data, pattern);
    savePatterns(this.data);
  }
}

export const ProactiveMemory = new ProactiveMemoryImpl();

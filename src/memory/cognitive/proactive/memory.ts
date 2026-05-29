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
import type { ModuleSignal } from "../../../orchestrator/types.js";

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

  /** Orchestrator signal: the highest-confidence proactive suggestion for the current context. */
  signalsFor(message: string, recentMessages: Array<{ role: string; content: string }>, timeOfDay: number): ModuleSignal[] {
    const suggestions = this.analyzeContext(message, recentMessages, timeOfDay);
    if (!suggestions || suggestions.length === 0) return [];
    const top = suggestions.sort((a, b) => b.confidence - a.confidence)[0];
    return [{ source: "proactive-memory", signal: top.message, priority: 3 + Math.round(top.confidence * 4), category: "proactive", confidence: 1.0 }];
  }

  /** Record a user interaction for pattern learning. */
  recordFrom(sessionId: string, message: string): void {
    this.recordInteraction(sessionId, message, Date.now());
  }
}

export const ProactiveMemory = new ProactiveMemoryImpl();

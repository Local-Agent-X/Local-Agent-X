export interface ProactiveSuggestion {
  type: "time" | "topic" | "behavioral" | "emotional" | "task";
  message: string;
  confidence: number; // 0–1
  source: string;
}

export interface InteractionPattern {
  type: "time" | "topic" | "behavioral" | "emotional" | "task";
  trigger: string;
  response: string;
  frequency: number;
  lastSeen: number;
  confidence: number;
}

export interface InteractionRecord {
  sessionId: string;
  message: string;
  timestamp: number;
  topics: string[];
}

export interface PatternsFile {
  patterns: InteractionPattern[];
  interactions: InteractionRecord[];
  topicIndex: Record<string, string[]>; // topic -> related topics seen together
}

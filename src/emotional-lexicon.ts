/**
 * Emotional lexicon — type definitions and the static keyword / emoji /
 * adaptation tables used to classify user emotional states.
 */

// ── Types ────────────────────────────────────────────────────

export interface EmotionState {
  primary: Emotion;
  confidence: number; // 0–1
  signals: string[];
}

export type Emotion =
  | "happy"
  | "frustrated"
  | "excited"
  | "grateful"
  | "confused"
  | "stressed"
  | "calm"
  | "curious"
  | "bored"
  | "angry";

export interface EmotionRecord {
  sessionId: string;
  emotion: EmotionState;
  context: string;
  timestamp: number;
}

export interface EmotionalProfile {
  totalRecords: number;
  topEmotions: Array<{ emotion: Emotion; count: number; pct: number }>;
  triggers: Array<{ context: string; emotion: Emotion; occurrences: number }>;
  timeOfDayPatterns: Array<{ hour: number; dominantEmotion: Emotion }>;
  summary: string;
}

// ── Keyword / pattern tables ────────────────────────────────

export const EMOTION_KEYWORDS: Record<Emotion, string[]> = {
  happy: [
    "love it", "awesome", "great", "wonderful", "fantastic", "nice",
    "perfect", "yay", "sweet", "amazing", "brilliant", "excellent",
    "happy", "glad", "thrilled", "delighted",
  ],
  frustrated: [
    "annoying", "frustrating", "broken", "doesn't work", "not working",
    "ugh", "again", "still broken", "why won't", "can't believe",
    "ridiculous", "terrible", "hate this", "so annoyed", "fed up",
  ],
  excited: [
    "can't wait", "excited", "let's go", "pumped", "stoked",
    "this is going to be", "just shipped", "finally", "woohoo",
    "let's do this", "so cool", "mind blown",
  ],
  grateful: [
    "thank you", "thanks", "appreciate", "grateful", "you're the best",
    "lifesaver", "helped a lot", "saved me", "couldn't have done",
    "so helpful", "much appreciated",
  ],
  confused: [
    "confused", "don't understand", "what do you mean", "huh",
    "makes no sense", "lost", "unclear", "not sure what",
    "how does", "wait what", "i'm lost", "explain",
  ],
  stressed: [
    "deadline", "running out of time", "too much", "overwhelmed",
    "stressed", "pressure", "urgent", "asap", "behind schedule",
    "crunch", "overloaded", "drowning",
  ],
  calm: [
    "no rush", "take your time", "whenever", "all good", "no worries",
    "relaxed", "chill", "easy", "peaceful", "steady",
  ],
  curious: [
    "wondering", "curious", "what if", "how would", "interesting",
    "tell me more", "explore", "dig into", "what about", "could we",
  ],
  bored: [
    "boring", "bored", "meh", "whatever", "don't care",
    "same old", "nothing new", "tedious", "monotonous",
  ],
  angry: [
    "angry", "furious", "pissed", "rage", "unacceptable",
    "livid", "outrageous", "infuriating", "wtf", "screw this",
    "this is garbage", "waste of time",
  ],
};

export const EMOJI_EMOTION: Array<{ pattern: RegExp; emotion: Emotion }> = [
  { pattern: /[😀😁😂🤣😃😄😆😊🥳🎉🎊]/u, emotion: "happy" },
  { pattern: /[😤😠😡🤬💢]/u, emotion: "angry" },
  { pattern: /[😕😟🤔❓]/u, emotion: "confused" },
  { pattern: /[😩😫😰😥😓]/u, emotion: "stressed" },
  { pattern: /[🤩🚀✨💥🔥⚡]/u, emotion: "excited" },
  { pattern: /[🙏❤️💖💙👏]/u, emotion: "grateful" },
  { pattern: /[😐😑😶🥱💤]/u, emotion: "bored" },
  { pattern: /[😖😣😞😔]/u, emotion: "frustrated" },
  { pattern: /[🧐🔍💡]/u, emotion: "curious" },
  { pattern: /[😌☺️🧘🌿]/u, emotion: "calm" },
];

// ── Adaptation hints ────────────────────────────────────────

export const ADAPTATION_HINTS: Record<Emotion, string> = {
  frustrated:
    "User seems frustrated. Be concise, avoid lengthy explanations, offer to take over the tedious parts.",
  angry:
    "User is upset. Acknowledge the frustration directly, stay solution-focused, avoid defensiveness.",
  confused:
    "User appears confused. Slow down, break things into smaller steps, use concrete examples.",
  stressed:
    "User is under pressure. Prioritize quick wins, offer to handle low-priority tasks, suggest breaks if appropriate.",
  excited:
    "User is excited! Match their energy, be enthusiastic, help them channel momentum productively.",
  happy:
    "User is in a good mood. Keep the positive tone, this is a great time for creative exploration.",
  grateful:
    "User expressed gratitude. Acknowledge warmly but briefly, keep the momentum going.",
  curious:
    "User is in exploration mode. Offer deeper dives, related topics, and alternative approaches.",
  bored:
    "User seems disengaged. Try introducing something novel, suggest a different approach, or ask what they'd prefer to work on.",
  calm:
    "User is relaxed and steady. Maintain a clear, measured pace. Good time for planning or review.",
};

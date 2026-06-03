// Weights for surfacing the user's most important memories. Confidence (how
// sure we are the fact is true) and emotional salience lead; recency is a light
// tiebreaker so stable identity facts aren't buried under fresh chatter.
export const WEIGHTS = {
  recency: 0.10,
  reinforcement: 0.15,
  confidence: 0.30,
  richness: 0.20,
  emotional: 0.25,
};

export const RECENCY_HALF_LIFE_DAYS = 14;
export const MS_PER_DAY = 86400000;

export const EMOTION_KEYWORDS = [
  "love", "hate", "angry", "happy", "sad", "excited", "afraid", "fear",
  "joy", "grief", "proud", "shame", "grateful", "anxious", "thrilled",
  "frustrated", "devastated", "ecstatic", "furious", "heartbroken",
  "passionate", "terrified", "disgusted", "amazed", "worried",
  "delighted", "miserable", "euphoric", "desperate", "hopeful",
  "important", "urgent", "critical", "emergency", "breakthrough",
];

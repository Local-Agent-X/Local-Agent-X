import { join } from "node:path";
import { getLaxDir } from "../../../lax-data-dir.js";

export const LAX_DIR = getLaxDir();
export const MEMORY_DIR = join(LAX_DIR, "memory");
export const ARCHIVE_DIR = join(LAX_DIR, "memory-archive");
export const SCORES_FILE = join(LAX_DIR, "memory-scores.json");

export const PROTECTED_FILES = new Set([
  "IDENTITY.md",
  "HEART.md",
  "USER.md",
]);

export const WEIGHTS = {
  recency: 0.25,
  frequency: 0.30,
  feedback: 0.20,
  richness: 0.15,
  emotional: 0.10,
};

export const RECENCY_HALF_LIFE_DAYS = 14;
export const DEFAULT_ARCHIVE_THRESHOLD = 15;
export const DECAY_PER_DAY = 1;
export const MS_PER_DAY = 86400000;

export const EMOTION_KEYWORDS = [
  "love", "hate", "angry", "happy", "sad", "excited", "afraid", "fear",
  "joy", "grief", "proud", "shame", "grateful", "anxious", "thrilled",
  "frustrated", "devastated", "ecstatic", "furious", "heartbroken",
  "passionate", "terrified", "disgusted", "amazed", "worried",
  "delighted", "miserable", "euphoric", "desperate", "hopeful",
  "important", "urgent", "critical", "emergency", "breakthrough",
];

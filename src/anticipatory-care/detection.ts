export function guessImportance(text: string): "low" | "medium" | "high" {
  const lower = text.toLowerCase();
  const highWords = [
    "deadline", "final", "important", "critical", "big", "major",
    "presentation", "interview", "exam", "surgery", "wedding",
    "launch", "demo", "court", "closing",
  ];
  const lowWords = [
    "maybe", "might", "probably", "thinking about", "casual",
    "coffee", "lunch", "errands",
  ];

  for (const w of highWords) {
    if (lower.includes(w)) return "high";
  }
  for (const w of lowWords) {
    if (lower.includes(w)) return "low";
  }
  return "medium";
}

export const EVENT_PATTERNS: { pattern: RegExp; eventExtractor: (match: RegExpMatchArray) => string }[] = [
  {
    pattern: /(?:i have|i've got|got)\s+(?:a|an|my)\s+(.+?)(?:\s+(?:tomorrow|today|on|next|this|at|in\s+\d))/i,
    eventExtractor: (m) => m[1].trim(),
  },
  {
    pattern: /(?:my|the)\s+(.+?)\s+is\s+(?:tomorrow|today|on|next|this)/i,
    eventExtractor: (m) => m[1].trim(),
  },
  {
    pattern: /(?:deadline|due date)\s+(?:is\s+)?(?:on\s+)?(.+)/i,
    eventExtractor: () => "deadline",
  },
  {
    pattern: /(?:flying|traveling|going|driving|heading)\s+to\s+(.+?)(?:\s+(?:tomorrow|today|next|this|on|in\s+\d)|$)/i,
    eventExtractor: (m) => `trip to ${m[1].trim()}`,
  },
  {
    pattern: /(?:meeting|call|appointment)\s+(?:with\s+)?(.+?)(?:\s+(?:tomorrow|today|next|this|on|at)|$)/i,
    eventExtractor: (m) => `meeting with ${m[1].trim()}`,
  },
];

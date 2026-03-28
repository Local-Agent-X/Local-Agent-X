export interface QualityScore {
  overall: number;
  lengthScore: number;
  toolUsageScore: number;
  errorScore: number;
  completionScore: number;
}

interface ResponseContext {
  expectedMinLength?: number;
  expectedMaxLength?: number;
  toolsAvailable?: boolean;
  toolsUsed?: number;
  hasErrors?: boolean;
  isComplete?: boolean;
  sessionId?: string;
}

const sessionScores: Map<string, QualityScore[]> = new Map();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function scoreLengthAppropriateness(text: string, ctx: ResponseContext): number {
  const len = text.length;
  if (len === 0) return 0;

  const minLen = ctx.expectedMinLength ?? 20;
  const maxLen = ctx.expectedMaxLength ?? 5000;

  if (len < minLen) return clamp((len / minLen) * 70, 0, 70);
  if (len > maxLen * 2) return 50;
  if (len > maxLen) return clamp(100 - ((len - maxLen) / maxLen) * 50, 50, 100);

  return 100;
}

function scoreToolUsage(ctx: ResponseContext): number {
  if (!ctx.toolsAvailable) return 100;
  if (ctx.toolsUsed === undefined) return 70;
  if (ctx.toolsUsed > 0) return 100;
  return 60;
}

function scoreErrorPresence(ctx: ResponseContext): number {
  return ctx.hasErrors ? 30 : 100;
}

function scoreCompletion(ctx: ResponseContext): number {
  if (ctx.isComplete === undefined) return 80;
  return ctx.isComplete ? 100 : 20;
}

export function scoreResponse(response: string, context: ResponseContext): QualityScore {
  const lengthScore = scoreLengthAppropriateness(response, context);
  const toolUsageScore = scoreToolUsage(context);
  const errorScore = scoreErrorPresence(context);
  const completionScore = scoreCompletion(context);

  const overall = Math.round(
    lengthScore * 0.2 + toolUsageScore * 0.25 + errorScore * 0.3 + completionScore * 0.25,
  );

  const score: QualityScore = {
    overall: clamp(overall, 0, 100),
    lengthScore: Math.round(lengthScore),
    toolUsageScore: Math.round(toolUsageScore),
    errorScore: Math.round(errorScore),
    completionScore: Math.round(completionScore),
  };

  if (context.sessionId) {
    const list = sessionScores.get(context.sessionId) ?? [];
    list.push(score);
    sessionScores.set(context.sessionId, list);
  }

  return score;
}

export function getAverageQuality(sessionId?: string): QualityScore | null {
  const entries: QualityScore[] = [];

  if (sessionId) {
    const list = sessionScores.get(sessionId);
    if (!list || list.length === 0) return null;
    entries.push(...list);
  } else {
    for (const list of sessionScores.values()) {
      entries.push(...list);
    }
    if (entries.length === 0) return null;
  }

  const avg = (key: keyof QualityScore) =>
    Math.round(entries.reduce((sum, s) => sum + s[key], 0) / entries.length);

  return {
    overall: avg("overall"),
    lengthScore: avg("lengthScore"),
    toolUsageScore: avg("toolUsageScore"),
    errorScore: avg("errorScore"),
    completionScore: avg("completionScore"),
  };
}

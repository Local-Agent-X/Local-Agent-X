import { describe, it, expect } from "vitest";
import { coreMemoryBody } from "./core-memory.js";
import { DEFAULT_MEMORY_CONFIG, type FactKind, type RetainedFact } from "./types.js";

const NOW = Date.parse("2026-11-11T20:40:00Z");
const DAY = 86_400_000;
const TZ = "America/Chicago";

function fact(id: number, kind: FactKind, content: string, timestamp: number): RetainedFact {
  return {
    id, kind, content, entities: [], confidence: 1, timestamp, lastUpdated: timestamp,
    evidenceFor: 0, evidenceAgainst: 0, sourceFile: "", sourceLine: 0,
  } as unknown as RetainedFact;
}

function memoryWith(ranked: RetainedFact[], all: RetainedFact[], maxBytes: number) {
  return {
    getConfig: () => ({ ...DEFAULT_MEMORY_CONFIG, coreFactsMaxBytes: maxBytes }),
    recallRecentFacts: () => ranked,
    recallByTime: (since: Date, until?: Date) =>
      all.filter((f) => f.timestamp >= since.getTime() && f.timestamp <= (until ?? new Date()).getTime())
        .sort((a, b) => b.timestamp - a.timestamp),
  };
}

// The hot score ranks by last touch: reinforced months-old facts filled the
// budget and yesterday's interview was cut, so a spoken "how are you?" the
// next afternoon asked if the interview was "around now" (2026-11-11).
describe("core memory", () => {
  const old = Array.from({ length: 10 }, (_, i) =>
    fact(100 + i, "world", `An old but often mentioned fact number ${i}, long enough to use the budget.`, NOW - 120 * DAY));
  const interview = fact(500, "experience", "Peter completed his first interview on 2026-11-10 and felt it went well.", NOW - 23 * 3_600_000);
  const lastWeek = fact(400, "experience", "Peter went to a concert.", NOW - 6 * DAY);

  it("holds the last few days' life events even when the ranked facts fill the budget", () => {
    const { body, renderedIds } = coreMemoryBody(memoryWith([...old, interview], [...old, interview, lastWeek], 300), TZ, NOW);
    expect(body).toContain("## Recent in their life");
    expect(body).toContain("completed his first interview");
    expect(body).toContain("2026-11-10: ");
    expect(renderedIds.has(500)).toBe(true);
  });

  it("puts the surest recent events first, so practice stories can't crowd out what happened", () => {
    const stories = Array.from({ length: 6 }, (_, i) => ({
      ...fact(600 + i, "experience", `Peter's mock interview story ${i}: a long rehearsed answer about a project he did once.`, NOW - 2 * 3_600_000),
      confidence: 0.8,
    }));
    const { body } = coreMemoryBody(memoryWith(old, [...stories, interview], 300), TZ, NOW);
    expect(body).toContain("completed his first interview");
  });

  it("leaves an older event to the ranked pick", () => {
    const { body } = coreMemoryBody(memoryWith(old, [...old, lastWeek], 300), TZ, NOW);
    expect(body).not.toContain("concert");
  });

  it("renders a fact once, in id order, whichever pass picked it", () => {
    const { body } = coreMemoryBody(memoryWith([interview, old[0]], [interview], 3000), TZ, NOW);
    expect(body.match(/completed his first interview/g)).toHaveLength(1);
    expect(body.indexOf("old but often")).toBeLessThan(body.indexOf("## Recent in their life"));
  });
});

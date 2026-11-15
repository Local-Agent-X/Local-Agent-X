// The one MMR for memory: auto-recall and memory_search's post-process both
// rank with it, so what each relies on is pinned here.
import { describe, expect, it } from "vitest";
import { mmrRerank } from "./mmr.js";

const hit = (snippet: string, score: number) => ({ snippet, score });
const order = (hits: { snippet: string }[]) => hits.map((h) => h.snippet);

describe("mmrRerank", () => {
  const top = hit("peter moved the shop to mckinney in june", 1);
  const dupe = hit("peter moved the shop to mckinney in june 2026", 0.95);
  const other = hit("the kraken bot trades eth on weekends", 0.9);

  it("ranks a different hit above a near duplicate at the default lambda", () => {
    expect(order(mmrRerank([top, dupe, other], 2))).toEqual([top.snippet, other.snippet]);
  });

  it("still ranks when every candidate fits in k, so a later cut drops the duplicate", () => {
    expect(order(mmrRerank([top, dupe, other], 9))).toEqual([top.snippet, other.snippet, dupe.snippet]);
  });

  it("does not treat two different non-Latin snippets as duplicates", () => {
    const tokyo = hit("東京の天気は晴れ", 1);
    const osaka = hit("大阪で会議がある", 0.95);
    expect(order(mmrRerank([tokyo, osaka, other], 2, 0.5))).toEqual([tokyo.snippet, osaka.snippet]);
  });

  it("returns nothing for k of zero", () => {
    expect(mmrRerank([top, other], 0)).toEqual([]);
  });
});

// Which chunks wait on a chunk that was set aside, and what the build tells
// its chat at the end.
import { describe, expect, it } from "vitest";
import type { ParsedChunk } from "../plan-parser.js";
import { anythingSetAside, blockedOn, createSetAsideLedger, holdBackWaiting, setAsideSummary } from "./set-aside.js";

const chunk = (number: number, dependsOn: number[] = []): ParsedChunk =>
  ({ number, title: `Chunk ${number}`, dependsOn }) as unknown as ParsedChunk;

describe("holdBackWaiting", () => {
  it("holds back a chunk that depends on a set-aside chunk, directly or through another", () => {
    const ledger = createSetAsideLedger();
    ledger.setAside.push({ chunk: 5, title: "Filter", reason: "misses no-risk" });

    const first = holdBackWaiting(ledger, [chunk(6), chunk(7, [5]), chunk(8, [4])]);
    expect(first.buildable.map((c) => c.number)).toEqual([6, 8]);
    expect(first.held).toEqual([{ chunk: 7, title: "Chunk 7", on: 5 }]);

    // Chunk 9 depends on chunk 7, which is waiting: it waits too.
    const second = holdBackWaiting(ledger, [chunk(9, [7]), chunk(10, [6])]);
    expect(second.buildable.map((c) => c.number)).toEqual([10]);
    expect(blockedOn(ledger, chunk(11, [9]))).toBe(9);
    expect(ledger.waiting.map((w) => [w.chunk, w.on])).toEqual([[7, 5], [9, 7]]);
  });

  it("holds nothing back when nothing was set aside", () => {
    const ledger = createSetAsideLedger();
    expect(holdBackWaiting(ledger, [chunk(1), chunk(2, [1])]).buildable).toHaveLength(2);
    expect(anythingSetAside(ledger)).toBe(false);
  });
});

describe("setAsideSummary", () => {
  it("says what landed, what was set aside and why, where its work is, and what waits", () => {
    const ledger = createSetAsideLedger();
    ledger.setAside.push({ chunk: 5, title: "Routing rule", reason: "the filter  misses\nthe hyphenated no-risk", branch: "autobuild/c5-3" });
    ledger.setAside.push({ chunk: 6, title: "Firebase setup", reason: "web apiKey missing" });
    ledger.waiting.push({ chunk: 8, title: "Sync", on: 6 });

    const text = setAsideSummary(ledger, [3, 4, 7]);
    expect(text).toContain("2 chunk(s) set aside");
    expect(text).toContain("Landed this run: chunk 3, chunk 4, chunk 7.");
    expect(text).toContain("Set aside — chunk 5 (Routing rule): the filter misses the hyphenated no-risk Its work is on branch 'autobuild/c5-3'.");
    expect(text).toContain("Set aside — chunk 6 (Firebase setup): web apiKey missing");
    expect(text).not.toContain("chunk 6 (Firebase setup): web apiKey missing Its work");
    expect(text).toContain("Not started, waiting on those: chunk 8 (on 6).");
    expect(text).toContain("chunks that landed are not built again");
  });

  it("cuts a long reason to a line the chat can read", () => {
    const ledger = createSetAsideLedger();
    ledger.setAside.push({ chunk: 1, title: "Big", reason: "x".repeat(5_000) });
    expect(setAsideSummary(ledger, []).length).toBeLessThan(1_200);
    expect(setAsideSummary(ledger, [])).toContain("Nothing landed this run.");
  });
});

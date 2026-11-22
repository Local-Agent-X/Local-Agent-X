// The heap watch reports once per step the heap climbs, and names the call
// sites still holding memory, each with its caller.
import { describe, expect, it } from "vitest";
import { crossedFraction, heapReportLine, topHolders, type HeapProfileNode } from "./heap-growth-watch.js";

const GB = 1e9;
const node = (functionName: string, url: string, line: number, selfSize: number, children: HeapProfileNode[] = []): HeapProfileNode =>
  ({ callFrame: { functionName, url, lineNumber: line }, selfSize, children });

describe("crossedFraction", () => {
  it("reports each step once as the heap climbs", () => {
    const reported = new Set<number>();
    expect(crossedFraction(1 * GB, 4 * GB, reported)).toBeNull();
    expect(crossedFraction(1.7 * GB, 4 * GB, reported)).toBe(0.4);
    expect(crossedFraction(1.9 * GB, 4 * GB, reported)).toBeNull();
    expect(crossedFraction(2.5 * GB, 4 * GB, reported)).toBe(0.6);
    expect(crossedFraction(3.3 * GB, 4 * GB, reported)).toBe(0.8);
    expect(crossedFraction(3.9 * GB, 4 * GB, reported)).toBeNull();
  });

  it("a heap that jumps past two steps reports the higher one, once", () => {
    const reported = new Set<number>();
    expect(crossedFraction(3.4 * GB, 4 * GB, reported)).toBe(0.8);
    expect(crossedFraction(3.5 * GB, 4 * GB, reported)).toBeNull();
  });

  it("does not report again after the heap falls and climbs back", () => {
    const reported = new Set<number>();
    crossedFraction(1.7 * GB, 4 * GB, reported);
    expect(crossedFraction(0.3 * GB, 4 * GB, reported)).toBeNull();
    expect(crossedFraction(1.8 * GB, 4 * GB, reported)).toBeNull();
  });

  it("says nothing without a limit to measure against", () => {
    expect(crossedFraction(1 * GB, 0, new Set())).toBeNull();
  });
});

describe("topHolders", () => {
  const parse = (size: number) => node("parse", "", 0, size);
  const profile = node("(root)", "", 0, 0, [
    node("listOps", "file:///C:/app/dist/ops/op-store.js", 338, 2e6, [
      node("readOp", "file:///C:/app/dist/ops/op-store.js", 327, 0, [parse(800e6)]),
    ]),
    node("load", "file:///C:/app/dist/memory/session-store.js", 90, 0, [parse(300e6), parse(100e6)]),
    node("tiny", "file:///C:/app/dist/x.js", 1, 1e3),
  ]);

  it("ranks call sites by the memory still alive, naming who called them", () => {
    const [first, second, third] = topHolders(profile, 3);
    expect(first).toEqual({ where: "parse", calledFrom: "readOp (dist/ops/op-store.js:328)", bytes: 800e6 });
    // The same function under another caller is its own line, summed per caller.
    expect(second).toEqual({ where: "parse", calledFrom: "load (dist/memory/session-store.js:91)", bytes: 400e6 });
    expect(third.where).toBe("listOps (dist/ops/op-store.js:339)");
  });

  it("puts them in one log line with the heap's size and the profile's path", () => {
    const line = heapReportLine(1.7 * GB, 4 * GB, topHolders(profile, 2), "C:/logs/heap-growth-x.heapprofile");
    expect(line).toContain("heap at 1,700 MB, 43% of its 4,000 MB limit");
    expect(line).toContain("parse called from readOp (dist/ops/op-store.js:328): 800 MB");
    expect(line).toContain("Full profile: C:/logs/heap-growth-x.heapprofile");
  });

  it("says so when nothing sampled is still alive", () => {
    expect(heapReportLine(1.7 * GB, 4 * GB, [], "p")).toContain("no sampled allocation is still alive");
  });
});

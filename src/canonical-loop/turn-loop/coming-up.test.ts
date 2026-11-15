import { describe, expect, it } from "vitest";
import { comingUpLine } from "./coming-up.js";

const ev = (id: string, title: string, start: string, end = start) => ({ id, title, start, end, sourceId: "lax" });

describe("what's coming up, in every chat", () => {
  it("lists the next commitments, marks overlaps, and fences titles as outside content", () => {
    const line = comingUpLine([
      ev("a", "Greg", "2026-11-14T17:00:00", "2026-11-14T18:00:00"),
      ev("b", "Vic", "2026-11-14T17:30:00", "2026-11-14T18:30:00"),
    ])!;
    expect(line).toContain("check it against these");
    expect(line).toContain("Greg (OVERLAPS Vic)");
    expect(line).toMatch(/EXTERNAL/);
    expect(comingUpLine([])).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import { runPlanReminderPass } from "./plan-reminders.js";
import { comingUpLine } from "../../canonical-loop/turn-loop/coming-up.js";

const now = () => new Date("2026-11-14T16:40:00");
const ev = (id: string, title: string, start: string, end = start) => ({ id, title, start, end, sourceId: "lax" });

describe("reminders before commitments", () => {
  it("posts one reminder per event starting within the lead time, keyed by occurrence, none for all-day events", async () => {
    const post = vi.fn((_r: { key: string; title: string; body: string }) => true);
    const window = vi.fn(async () => ({ events: [
      ev("a", "Dinner with Greg", "2026-11-14T17:00:00", "2026-11-14T18:00:00"),
      ev("b", "Holiday", "2026-11-14"),
      ev("c", "Later", "2026-11-14T19:00:00"),
    ], unreadable: [] }));
    expect(await runPlanReminderPass({ now, window, post, leadMinutes: () => 30 })).toBe(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ key: `reminder:lax:a:${Date.parse("2026-11-14T17:00:00")}` }));
    expect(post.mock.calls[0]?.[0].title).toContain("Dinner with Greg");
  });

  it("does nothing when the user turned reminders off", async () => {
    const window = vi.fn();
    expect(await runPlanReminderPass({ now, window, leadMinutes: () => 0 })).toBe(0);
    expect(window).not.toHaveBeenCalled();
  });
});

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

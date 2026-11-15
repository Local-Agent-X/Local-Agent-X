import { describe, expect, it } from "vitest";
import { composeDigest } from "./situational-awareness.js";
import { toldUserLine } from "./told-user.js";

const now = new Date("2026-11-14T21:05:00Z");
const digest = { title: "Mail digest: 26 messages that didn't need you right away", body: "• Academy Sports: Ends Tomorrow!\n• Kalshi: $25 bonus", createdAt: now.getTime() - 2 * 60 * 60 * 1000 };

describe("what LAX told the user", () => {
  it("lists titles with their age, never contents, fenced as external content, and says they are the agent's own", () => {
    const line = toldUserLine([digest], now)!;
    expect(line).toContain("You sent these");
    expect(line).toContain("(2 h ago) Mail digest: 26 messages");
    expect(line).not.toContain("Kalshi");
    expect(line).toMatch(/EXTERNAL/);
  });

  it("is absent when nothing was told, and cuts a long title", () => {
    expect(toldUserLine([], now)).toBeNull();
    const long = toldUserLine([{ ...digest, title: "x".repeat(5000) }], now)!;
    expect(long.length).toBeLessThan(1500);
  });

  it("rides the situational digest", () => {
    const d = composeDigest({ turnIdx: 0, recent: [], firstUserText: "", toldUser: [digest], now })!;
    expect(d).toContain("Mail digest: 26 messages");
    expect(composeDigest({ turnIdx: 0, recent: [], firstUserText: "" })).toBeNull();
  });
});

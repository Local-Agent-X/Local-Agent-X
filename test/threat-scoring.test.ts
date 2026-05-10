import { describe, it, expect } from "vitest";
import { ThreatScorer, THREAT_SCORES } from "../src/threat/scoring.js";

describe("ThreatScorer — initial state", () => {
  it("starts at score 0 / level normal", () => {
    const s = new ThreatScorer();
    expect(s.getStatus()).toEqual({ score: 0, level: "normal" });
  });

  it("isRestricted is false at zero", () => {
    const s = new ThreatScorer();
    expect(s.isRestricted()).toBe(false);
  });
});

describe("ThreatScorer — level thresholds", () => {
  it("crosses to elevated at 30", () => {
    const s = new ThreatScorer();
    s.record("test", 30, "x");
    expect(s.getStatus().level).toBe("elevated");
  });

  it("crosses to high at 60 and triggers restricted mode", () => {
    const s = new ThreatScorer();
    s.record("test", 60, "x");
    expect(s.getStatus().level).toBe("high");
    expect(s.isRestricted()).toBe(true);
  });

  it("crosses to critical at 85", () => {
    const s = new ThreatScorer();
    s.record("test", 85, "x");
    expect(s.getStatus().level).toBe("critical");
  });

  it("stays normal just below elevated threshold", () => {
    const s = new ThreatScorer();
    s.record("test", 29, "x");
    expect(s.getStatus().level).toBe("normal");
  });
});

describe("ThreatScorer — decay behavior", () => {
  it("decays older score by 5% on each new event, but never falls below the latest score", () => {
    const s = new ThreatScorer();
    s.record("first", 80, "x");           // base = 80
    const after = s.record("small", 1, "x"); // 80*0.95 + 1 = 77; floor = max(77, 1) = 77
    expect(after.score).toBe(77);
  });

  it("a single big event raises the floor — subsequent small events do not erase it", () => {
    const s = new ThreatScorer();
    s.record("big", 90, "x");
    for (let i = 0; i < 3; i++) s.record("small", 0, "y");
    // 90 * 0.95^3 ≈ 77, score stays high
    expect(s.getStatus().score).toBeGreaterThan(70);
  });

  it("the new event score acts as a floor when decay would push lower", () => {
    const s = new ThreatScorer();
    s.record("init", 10, "x");
    const after = s.record("big", 50, "y"); // 10*0.95 + 50 = 59.5; floor = max(59.5, 50) = 59.5
    expect(after.score).toBeGreaterThanOrEqual(50);
  });
});

describe("ThreatScorer — events history", () => {
  it("getEvents returns a copy of the recorded events", () => {
    const s = new ThreatScorer();
    s.record("a", 10, "first");
    s.record("b", 20, "second");
    const events = s.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("a");
    expect(events[1].detail).toBe("second");
  });

  it("getEvents returns a copy — mutating it does not affect internal state", () => {
    const s = new ThreatScorer();
    s.record("a", 1, "x");
    const copy = s.getEvents();
    copy.length = 0;
    expect(s.getEvents()).toHaveLength(1);
  });

  it("caps event history at MAX_EVENTS (200)", () => {
    const s = new ThreatScorer();
    for (let i = 0; i < 250; i++) s.record("t", 0, "x");
    expect(s.getEvents().length).toBeLessThanOrEqual(200);
  });
});

describe("ThreatScorer — reset", () => {
  it("clears score back to 0/normal", () => {
    const s = new ThreatScorer();
    s.record("big", 80, "x");
    s.reset();
    expect(s.getStatus()).toEqual({ score: 0, level: "normal" });
    expect(s.getEvents()).toEqual([]);
  });
});

describe("THREAT_SCORES — invariants", () => {
  it("critical-class events are scored higher than medium-class events", () => {
    expect(THREAT_SCORES.credential_in_output).toBeGreaterThan(THREAT_SCORES.shell_command);
    expect(THREAT_SCORES.canary_tripped).toBeGreaterThan(THREAT_SCORES.security_block);
  });

  it("low-risk events are scored ≤ 5", () => {
    expect(THREAT_SCORES.tool_call).toBeLessThanOrEqual(5);
    expect(THREAT_SCORES.file_read).toBeLessThanOrEqual(5);
    expect(THREAT_SCORES.web_fetch).toBeLessThanOrEqual(5);
  });
});

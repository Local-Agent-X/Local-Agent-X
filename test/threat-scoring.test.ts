import { describe, it, expect } from "vitest";
import { DETERMINISTIC_EVIDENCE_TYPES, ThreatScorer, THREAT_SCORES } from "../src/threat/scoring.js";

// Tests against the raw threshold mechanism use startingBudget: 0 so the
// effective load equals the raw load — the new fresh-install calibration
// (budget + decay) is exercised by its own describe blocks below.
const RAW = { startingBudget: 0, decayPerHour: 0, decayPerTurn: 0 } as const;

describe("ThreatScorer — initial state", () => {
  it("starts at score 0 / level normal", () => {
    const s = new ThreatScorer(RAW);
    expect(s.getStatus()).toEqual({ score: 0, level: "normal" });
  });

  it("isRestricted is false at zero", () => {
    const s = new ThreatScorer(RAW);
    expect(s.isRestricted()).toBe(false);
  });
});

describe("ThreatScorer — level thresholds (no budget, no decay)", () => {
  it("crosses to elevated at 30", () => {
    const s = new ThreatScorer(RAW);
    s.record("test", 30, "x");
    expect(s.getStatus().level).toBe("elevated");
  });

  it("crosses to high at 60 and triggers restricted mode (with evidence-type event)", () => {
    const s = new ThreatScorer(RAW);
    // credential_in_output is a deterministic-evidence type — restriction
    // requires load ≥ 60 AND evidence, and this event supplies both.
    s.record("credential_in_output", 60, "x");
    expect(s.getStatus().level).toBe("high");
    expect(s.isRestricted()).toBe(true);
  });

  it("crosses to critical at 85", () => {
    const s = new ThreatScorer(RAW);
    s.record("test", 85, "x");
    expect(s.getStatus().level).toBe("critical");
  });

  it("stays normal just below elevated threshold", () => {
    const s = new ThreatScorer(RAW);
    s.record("test", 29, "x");
    expect(s.getStatus().level).toBe("normal");
  });
});

describe("ThreatScorer — decay behavior (raw load shape unchanged)", () => {
  it("decays older raw load by 5% on each new event, but never falls below the latest score", () => {
    const s = new ThreatScorer(RAW);
    s.record("first", 80, "x");           // raw = 80
    const after = s.record("small", 1, "x"); // 80*0.95 + 1 = 77; floor = max(77, 1) = 77
    expect(after.score).toBe(77);
  });

  it("a single big event raises the floor — subsequent small events do not erase it", () => {
    const s = new ThreatScorer(RAW);
    s.record("big", 90, "x");
    for (let i = 0; i < 3; i++) s.record("small", 0, "y");
    // 90 * 0.95^3 ≈ 77, score stays high
    expect(s.getStatus().score).toBeGreaterThan(70);
  });

  it("the new event score acts as a floor when decay would push lower", () => {
    const s = new ThreatScorer(RAW);
    s.record("init", 10, "x");
    const after = s.record("big", 50, "y"); // 10*0.95 + 50 = 59.5; floor = max(59.5, 50) = 59.5
    expect(after.score).toBeGreaterThanOrEqual(50);
  });
});

describe("ThreatScorer — events history", () => {
  it("getEvents returns a copy of the recorded events", () => {
    const s = new ThreatScorer(RAW);
    s.record("a", 10, "first");
    s.record("b", 20, "second");
    const events = s.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("a");
    expect(events[1].detail).toBe("second");
  });

  it("getEvents returns a copy — mutating it does not affect internal state", () => {
    const s = new ThreatScorer(RAW);
    s.record("a", 1, "x");
    const copy = s.getEvents();
    copy.length = 0;
    expect(s.getEvents()).toHaveLength(1);
  });

  it("caps event history at MAX_EVENTS (200)", () => {
    const s = new ThreatScorer(RAW);
    for (let i = 0; i < 250; i++) s.record("t", 0, "x");
    expect(s.getEvents().length).toBeLessThanOrEqual(200);
  });
});

describe("ThreatScorer — reset", () => {
  it("clears score back to 0/normal", () => {
    const s = new ThreatScorer(RAW);
    s.record("big", 80, "x");
    s.reset();
    expect(s.getStatus()).toEqual({ score: 0, level: "normal" });
    expect(s.getEvents()).toEqual([]);
  });
});

describe("ThreatScorer — confirmed breach latch (canary trip)", () => {
  it("a single canary trip forces restriction even under the default budget", () => {
    // Regression for SC-3: canary_tripped (50) < default startingBudget (60),
    // so the old model gave effectiveLoad 0 → normal → external tools open.
    const s = new ThreatScorer(); // defaults: budget=60
    s.record("canary_tripped", THREAT_SCORES.canary_tripped, "leaked canary token");
    expect(s.isRestricted()).toBe(true);
    expect(s.getStatus().level).toBe("critical");
  });

  it("the restriction latches — a subsequent calm turn does not unlock it", () => {
    let clock = 1_000_000;
    const s = new ThreatScorer({ now: () => clock }); // default budget/decay
    s.record("canary_tripped", THREAT_SCORES.canary_tripped, "leak");
    // Trust regeneration must not excuse a confirmed breach.
    for (let i = 0; i < 100; i++) s.recordSuccessfulTurn();
    clock += 100 * 60 * 60 * 1000; // 100 hours of quiet
    expect(s.isRestricted()).toBe(true);
  });

  it("reset clears the breach latch", () => {
    const s = new ThreatScorer();
    s.record("canary_tripped", THREAT_SCORES.canary_tripped, "leak");
    expect(s.isRestricted()).toBe(true);
    s.reset();
    expect(s.isRestricted()).toBe(false);
    expect(s.getStatus().level).toBe("normal");
  });

  it("non-canary sub-budget signals still stay normal (latch is scoped to confirmed breaches)", () => {
    const s = new ThreatScorer(); // budget=60
    s.record("sensitive_file_read", THREAT_SCORES.sensitive_file_read, "x");
    expect(s.isRestricted()).toBe(false);
    expect(s.getStatus().level).toBe("normal");
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

// ═══════════════════════════════════════════════════════════════════
// Fresh-install calibration — starting budget + decay model
//
// Fresh sessions used to trip the threat gate on a single sensitive-topic
// research session because they had no accumulated trust against which to
// weigh the signal. The fix adds a starting budget plus time/turn-based
// decay, without changing any threshold or signal score.
// ═══════════════════════════════════════════════════════════════════

describe("ThreatScorer — fresh-install starting budget", () => {
  it("default budget absorbs a single sensitive research signal", () => {
    // Simulates "research home break-in patterns for executive protection":
    // one credential_in_output (30) hit. Old model: rawLoad=30 → elevated.
    // New model: 30 - 60 budget = 0 → normal. No false positive.
    const s = new ThreatScorer(); // defaults
    s.record("credential_in_output", THREAT_SCORES.credential_in_output, "research keyword");
    const status = s.getStatus();
    expect(status.level).toBe("normal");
    expect(status.score).toBe(0);
    expect(s.isRestricted()).toBe(false);
  });

  it("absorbs a typical research-session signal volume (5-10 medium signals) without elevating", () => {
    const s = new ThreatScorer(); // defaults: budget=60
    for (let i = 0; i < 8; i++) {
      s.record("sensitive_file_read", THREAT_SCORES.sensitive_file_read, `keyword #${i}`);
    }
    expect(s.isRestricted()).toBe(false);
    expect(s.getStatus().level).not.toBe("high");
    expect(s.getStatus().level).not.toBe("critical");
  });

  it("absorbs ~original-threshold signal volume but elevates at roughly 3× that volume", () => {
    // Use a clock so this test is independent of wall-time decay.
    let clock = 1_000_000;
    const mk = () => new ThreatScorer({ startingBudget: 60, decayPerHour: 0, decayPerTurn: 0, now: () => clock });

    // Baseline: under the old model, a sequence of N high-class signals
    // (credential_in_output, 30 each) crossed the gate at ~N=2 raw.
    // Verify the new model lets that same N through.
    const small = mk();
    small.record("credential_in_output", 30, "x");
    small.record("credential_in_output", 30, "x");
    expect(small.isRestricted()).toBe(false);

    // Triple the signal volume → elevation still possible. The threshold
    // didn't move; just the absorption capacity below it.
    const big = mk();
    for (let i = 0; i < 6; i++) big.record("credential_in_output", 30, "x");
    expect(big.isRestricted()).toBe(true);
  });

  it("budget defaults to 60", () => {
    const s = new ThreatScorer();
    expect(s.startingBudget).toBe(60);
  });
});

describe("ThreatScorer — time-based decay", () => {
  it("a spike at t=0 followed by 24 hours of quiet drains the load below high threshold", () => {
    let clock = 1_000_000;
    const s = new ThreatScorer({ startingBudget: 0, decayPerHour: 5, decayPerTurn: 0, now: () => clock });
    // Park a single spike at the high threshold under the no-budget model.
    s.record("credential_in_output", 60, "spike");
    expect(s.isRestricted()).toBe(true);

    // Fast-forward 24 hours: 24 * 5 = 120 of decay credit, far exceeding 60.
    clock += 24 * 60 * 60 * 1000;
    expect(s.isRestricted()).toBe(false);
    expect(s.getStatus().level).toBe("normal");
  });

  it("a fresh spike resets the decay clock — prior credit doesn't excuse new signal", () => {
    let clock = 1_000_000;
    const s = new ThreatScorer({ startingBudget: 0, decayPerHour: 5, decayPerTurn: 0, now: () => clock });
    s.record("credential_in_output", 30, "first");
    clock += 24 * 60 * 60 * 1000; // 24h of credit accrued
    // New spike — credit clock resets to now, so the latest signal is judged on its own.
    s.record("credential_in_output", 60, "second");
    expect(s.getStatus().score).toBeGreaterThan(0);
  });
});

describe("ThreatScorer — turn-based decay", () => {
  it("recordSuccessfulTurn() reduces effective load (max of time/turn credit)", () => {
    let clock = 1_000_000;
    const s = new ThreatScorer({ startingBudget: 0, decayPerHour: 0, decayPerTurn: 2, now: () => clock });
    s.record("credential_in_output", 60, "spike");
    expect(s.isRestricted()).toBe(true);

    // 50 calm turns at 2 credit each = 100 credit > 60 spike → no longer restricted.
    for (let i = 0; i < 50; i++) s.recordSuccessfulTurn();
    expect(s.isRestricted()).toBe(false);
  });

  it("uses max(timeCredit, turnCredit) — stronger wins", () => {
    let clock = 1_000_000;
    const s = new ThreatScorer({ startingBudget: 0, decayPerHour: 100, decayPerTurn: 1, now: () => clock });
    s.record("credential_in_output", 60, "spike");
    clock += 60 * 60 * 1000; // 1 hour → 100 time credit, eats the whole 60 load
    expect(s.isRestricted()).toBe(false);
  });

  it("a new threat event resets the calm-turn counter — past trust doesn't excuse new signal", () => {
    let clock = 1_000_000;
    const s = new ThreatScorer({ startingBudget: 0, decayPerHour: 0, decayPerTurn: 5, now: () => clock });
    s.record("credential_in_output", 60, "spike");
    for (let i = 0; i < 100; i++) s.recordSuccessfulTurn();
    expect(s.isRestricted()).toBe(false);

    // New spike — calm-turn buffer is gone, this signal stands alone.
    s.record("credential_in_output", 60, "second spike");
    expect(s.isRestricted()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Evidence gate — load alone must not restrict
//
// A session that accumulates heuristic signal (sensitive reads, shell
// commands) past HIGH_THRESHOLD with ZERO deterministic evidence was being
// network-restricted with a message claiming a network failure (live flail
// 2026-07-23). Restriction now requires load ≥ 60 AND at least one recorded
// event from DETERMINISTIC_EVIDENCE_TYPES. confirmedBreach latch unchanged.
// ═══════════════════════════════════════════════════════════════════

describe("ThreatScorer — deterministic-evidence gate", () => {
  it("names exactly the four deterministic evidence types", () => {
    expect([...DETERMINISTIC_EVIDENCE_TYPES].sort()).toEqual([
      "canary_tripped", "credential_in_output", "exfiltration", "secrets_in_output",
    ]);
  });

  it("load ≥ 60 from heuristic-only events does NOT restrict", () => {
    const s = new ThreatScorer(RAW);
    // Many sensitive reads + shell commands: level climbs, but none of these
    // is deterministic evidence, so restriction must not engage.
    for (let i = 0; i < 30; i++) {
      s.record("sensitive_file_read", THREAT_SCORES.sensitive_file_read, `read #${i}`);
      s.record("shell_command", THREAT_SCORES.shell_command, `cmd #${i}`);
    }
    expect(s.getStatus().score).toBeGreaterThanOrEqual(s.HIGH_THRESHOLD);
    expect(s.isRestricted()).toBe(false);
    expect(s.getEvidenceTypes()).toEqual([]);
  });

  it("loop-type events (incl. encoding-prep, scored as 'loop') are not evidence", () => {
    const s = new ThreatScorer(RAW);
    for (let i = 0; i < 30; i++) s.record("loop", THREAT_SCORES.loop_detected, `loop #${i}`);
    expect(s.getStatus().score).toBeGreaterThanOrEqual(s.HIGH_THRESHOLD);
    expect(s.isRestricted()).toBe(false);
  });

  it("the same heuristic load plus ONE exfiltration evidence event DOES restrict", () => {
    const s = new ThreatScorer(RAW);
    for (let i = 0; i < 30; i++) {
      s.record("sensitive_file_read", THREAT_SCORES.sensitive_file_read, `read #${i}`);
      s.record("shell_command", THREAT_SCORES.shell_command, `cmd #${i}`);
    }
    expect(s.isRestricted()).toBe(false);
    s.record("exfiltration", THREAT_SCORES.exfiltration_pattern, "secret on the wire");
    expect(s.isRestricted()).toBe(true);
    expect(s.getEvidenceTypes()).toEqual(["exfiltration"]);
  });

  it("evidence with load still below threshold does not restrict (gate needs BOTH)", () => {
    const s = new ThreatScorer(RAW);
    s.record("exfiltration", THREAT_SCORES.exfiltration_pattern, "one exfil, 25 < 60");
    expect(s.isRestricted()).toBe(false);
  });

  it("canary latch is unchanged — restricts regardless of load/budget", () => {
    const s = new ThreatScorer(); // default budget 60 absorbs the 50 score
    s.record("canary_tripped", THREAT_SCORES.canary_tripped, "leak");
    expect(s.getStatus().score).toBe(0);
    expect(s.isRestricted()).toBe(true);
  });
});

describe("ThreatScorer — snapshot/restore carries the evidence gate", () => {
  it("round-trips a restricted-with-evidence scorer (evidence derives from persisted events — no new fields)", () => {
    const s = new ThreatScorer(RAW);
    for (let i = 0; i < 30; i++) s.record("sensitive_file_read", THREAT_SCORES.sensitive_file_read, `r${i}`);
    s.record("exfiltration", THREAT_SCORES.exfiltration_pattern, "wire");
    expect(s.isRestricted()).toBe(true);

    const restored = new ThreatScorer(RAW);
    restored.restore(s.snapshot());
    expect(restored.isRestricted()).toBe(true);
    expect(restored.getEvidenceTypes()).toEqual(["exfiltration"]);
  });

  it("round-trips a high-load evidence-free scorer as still unrestricted", () => {
    const s = new ThreatScorer(RAW);
    for (let i = 0; i < 40; i++) s.record("sensitive_file_read", THREAT_SCORES.sensitive_file_read, `r${i}`);
    expect(s.getStatus().score).toBeGreaterThanOrEqual(s.HIGH_THRESHOLD);
    expect(s.isRestricted()).toBe(false);

    const restored = new ThreatScorer(RAW);
    restored.restore(s.snapshot());
    expect(restored.isRestricted()).toBe(false);
    expect(restored.getStatus()).toEqual(s.getStatus());
  });
});

describe("ThreatScorer — settings override (constructor injection)", () => {
  it("a configured budget of 0 reproduces the pre-calibration behavior", () => {
    const s = new ThreatScorer({ startingBudget: 0, decayPerHour: 0, decayPerTurn: 0 });
    s.record("credential_in_output", 60, "x");
    expect(s.isRestricted()).toBe(true);
  });

  it("a configured budget of 120 makes the gate need twice the signal", () => {
    const s = new ThreatScorer({ startingBudget: 120, decayPerHour: 0, decayPerTurn: 0 });
    s.record("credential_in_output", 60, "x");
    expect(s.isRestricted()).toBe(false);
    // Need to push rawLoad past 120 + 60 = 180 → asymptotic with 60-class
    // events takes a few iterations: 60, 60+57=117, 117*.95+60=171, *.95+60=222.
    s.record("credential_in_output", 60, "x");
    s.record("credential_in_output", 60, "x");
    s.record("credential_in_output", 60, "x");
    expect(s.isRestricted()).toBe(true);
  });

  it("decayPerHour is honored — 0 disables time decay entirely", () => {
    let clock = 1_000_000;
    const s = new ThreatScorer({ startingBudget: 0, decayPerHour: 0, decayPerTurn: 0, now: () => clock });
    s.record("credential_in_output", 60, "x");
    clock += 10_000 * 60 * 60 * 1000; // 10k hours
    expect(s.isRestricted()).toBe(true);
  });
});

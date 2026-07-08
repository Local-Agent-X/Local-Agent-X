import { describe, it, expect, beforeEach } from "vitest";
import {
  boostNudgePriority,
  checkAndConsumeNudge,
  hasCurateSignal,
  resetSession,
  _internals,
} from "../src/memory/curate-nudge.js";

const SESSION_A = "test-session-A";
const SESSION_B = "test-session-B";

beforeEach(() => {
  // Each test starts with a clean per-session counter
  resetSession(SESSION_A);
  resetSession(SESSION_B);
});

describe("curate-nudge — cadence (no boosts)", () => {
  it("does not fire before NUDGE_INTERVAL turns elapse", () => {
    for (let i = 0; i < _internals.NUDGE_INTERVAL - 1; i++) {
      expect(checkAndConsumeNudge(SESSION_A)).toBeNull();
    }
  });

  it("fires exactly on the Nth turn", () => {
    let nudge: string | null = null;
    for (let i = 0; i < _internals.NUDGE_INTERVAL; i++) {
      nudge = checkAndConsumeNudge(SESSION_A);
    }
    expect(nudge).not.toBeNull();
    expect(nudge).toContain("memory-curate");
  });

  it("resets after firing — does not re-fire on the very next turn", () => {
    for (let i = 0; i < _internals.NUDGE_INTERVAL; i++) checkAndConsumeNudge(SESSION_A);
    // First post-fire turn: should not re-fire
    expect(checkAndConsumeNudge(SESSION_A)).toBeNull();
  });

  it("re-fires after another full interval", () => {
    for (let i = 0; i < _internals.NUDGE_INTERVAL; i++) checkAndConsumeNudge(SESSION_A);
    // Should fire again N turns later
    let second: string | null = null;
    for (let i = 0; i < _internals.NUDGE_INTERVAL; i++) second = checkAndConsumeNudge(SESSION_A);
    expect(second).not.toBeNull();
  });
});

describe("curate-nudge — opportunistic boosts", () => {
  it("boost('explicit-remember') fires the nudge on next turn", () => {
    boostNudgePriority(SESSION_A, "explicit-remember");
    const nudge = checkAndConsumeNudge(SESSION_A);
    expect(nudge).not.toBeNull();
    expect(nudge).toContain("explicitly asked you to remember");
  });

  it("boost('correction-detected') fires the nudge on next turn", () => {
    boostNudgePriority(SESSION_A, "correction-detected");
    const nudge = checkAndConsumeNudge(SESSION_A);
    expect(nudge).not.toBeNull();
    expect(nudge).toContain("pushed back");
  });

  it("boost('preference-stated') does NOT fire immediately (half-interval boost)", () => {
    boostNudgePriority(SESSION_A, "preference-stated");
    // Half-interval boost; needs more turns to cross the threshold
    expect(checkAndConsumeNudge(SESSION_A)).toBeNull();
  });

  it("multiple weak boosts compound to fire the nudge", () => {
    boostNudgePriority(SESSION_A, "preference-stated");  // ~5
    boostNudgePriority(SESSION_A, "long-task-completed"); // ~4
    // The first checkAndConsumeNudge adds 1 (this turn) — combined ~10 > NUDGE_INTERVAL
    const nudge = checkAndConsumeNudge(SESSION_A);
    expect(nudge).not.toBeNull();
  });

  it("opportunistic nudge mentions all triggers that fired since the last nudge", () => {
    boostNudgePriority(SESSION_A, "explicit-remember");
    boostNudgePriority(SESSION_A, "preference-stated");
    const nudge = checkAndConsumeNudge(SESSION_A) || "";
    expect(nudge).toContain("explicitly asked you to remember");
    expect(nudge).toContain("stated a preference");
  });

  it("boosts are idempotent within a single turn (same trigger doesn't compound)", () => {
    boostNudgePriority(SESSION_A, "preference-stated");
    boostNudgePriority(SESSION_A, "preference-stated");
    boostNudgePriority(SESSION_A, "preference-stated");
    // Three boosts of the same type = one half-interval bump, not three
    const after = _internals.getSession(SESSION_A);
    expect(after.turnsSinceNudge).toBe(_internals.TRIGGER_BOOST["preference-stated"]);
  });
});

describe("curate-nudge — session isolation", () => {
  it("counters are per-session — boost on A does not affect B", () => {
    boostNudgePriority(SESSION_A, "explicit-remember");
    expect(checkAndConsumeNudge(SESSION_B)).toBeNull();
    expect(checkAndConsumeNudge(SESSION_A)).not.toBeNull();
  });

  it("fire on A does not reset B's counter", () => {
    for (let i = 0; i < _internals.NUDGE_INTERVAL - 1; i++) checkAndConsumeNudge(SESSION_B);
    boostNudgePriority(SESSION_A, "explicit-remember");
    checkAndConsumeNudge(SESSION_A); // A fires
    // B was at NUDGE_INTERVAL-1 — its next turn should fire it
    expect(checkAndConsumeNudge(SESSION_B)).not.toBeNull();
  });
});

describe("curate-nudge — hasCurateSignal (end-of-turn extraction gate)", () => {
  it("is false for an unknown session and never creates state", () => {
    expect(hasCurateSignal("never-seen-session")).toBe(false);
    expect(_internals.sessions.has("never-seen-session")).toBe(false);
  });

  it("is false for a session with only routine turns (no boost, no fired nudge)", () => {
    checkAndConsumeNudge(SESSION_A); // one routine turn, below cadence
    expect(hasCurateSignal(SESSION_A)).toBe(false);
  });

  it("turns true after a boost, and back false after resetSession (consumed)", () => {
    boostNudgePriority(SESSION_A, "preference-stated");
    expect(hasCurateSignal(SESSION_A)).toBe(true);
    resetSession(SESSION_A); // what the end-of-turn pass does after a run
    expect(hasCurateSignal(SESSION_A)).toBe(false);
  });

  it("stays true after a cadence nudge fires (lastNudgeAt), until reset", () => {
    for (let i = 0; i < _internals.NUDGE_INTERVAL; i++) checkAndConsumeNudge(SESSION_A);
    // Triggers were cleared by the fire, but the fired nudge itself is a signal.
    expect(hasCurateSignal(SESSION_A)).toBe(true);
  });
});

describe("curate-nudge — defensive cases", () => {
  it("empty sessionId is a no-op", () => {
    boostNudgePriority("", "explicit-remember");
    expect(checkAndConsumeNudge("")).toBeNull();
  });

  it("forceFire returns nudge text regardless of cadence", () => {
    const nudge = checkAndConsumeNudge(SESSION_A, { forceFire: true });
    expect(nudge).not.toBeNull();
    expect(nudge).toContain("memory-curate");
  });

  it("nudge text instructs the model to use memory_update_profile", () => {
    boostNudgePriority(SESSION_A, "explicit-remember");
    const nudge = checkAndConsumeNudge(SESSION_A) || "";
    expect(nudge).toContain("memory_update_profile");
  });

  it("nudge text reminds about cross-provider visibility", () => {
    boostNudgePriority(SESSION_A, "explicit-remember");
    const nudge = checkAndConsumeNudge(SESSION_A) || "";
    expect(nudge.toLowerCase()).toMatch(/provider|generally|transfer/);
  });

  it("routine cadence nudge is softer in framing than opportunistic", () => {
    // Force routine fire
    for (let i = 0; i < _internals.NUDGE_INTERVAL; i++) {
      var routine = checkAndConsumeNudge(SESSION_A);
    }
    // Compare to opportunistic
    boostNudgePriority(SESSION_B, "explicit-remember");
    const opportunistic = checkAndConsumeNudge(SESSION_B) || "";
    const routineStr = routine || "";
    expect(routineStr).toContain("Periodic review");
    expect(opportunistic).toContain("Recent signal");
  });
});

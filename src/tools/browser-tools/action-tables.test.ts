/**
 * Relational invariants between the browser action-classification tables.
 * These are the properties the gate pipeline relies on — not a restatement of
 * the membership lists themselves (those are pinned by the gate tests that
 * drive execute() end to end).
 */
import { describe, expect, it } from "vitest";
import {
  RESET_ACTIONS,
  TRACKED_ACTIONS,
  READ_ONLY_ACTIONS,
  HUMAN_VERIFICATION_BLOCKED_ACTIONS,
} from "./action-tables.js";

const intersect = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x));

describe("browser action tables", () => {
  it("never tracks progress for a read-only action (a read never 'tries to move the page')", () => {
    expect(intersect(TRACKED_ACTIONS, READ_ONLY_ACTIONS)).toEqual([]);
  });

  it("never treats an action as both a context reset and an advancing action", () => {
    expect(intersect(RESET_ACTIONS, TRACKED_ACTIONS)).toEqual([]);
  });

  it("blocks every advancing action while a human-verification challenge is up", () => {
    for (const action of TRACKED_ACTIONS) {
      expect(HUMAN_VERIFICATION_BLOCKED_ACTIONS.has(action)).toBe(true);
    }
  });

  it("leaves every read-only escape/observation action available during verification", () => {
    expect(intersect(READ_ONLY_ACTIONS, HUMAN_VERIFICATION_BLOCKED_ACTIONS)).toEqual([]);
  });
});

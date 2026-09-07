/**
 * Relational invariants between the browser action-classification tables, the
 * MEMBERSHIP facts the gates depend on, and the tables' immutability.
 *
 * The membership assertions are deliberately explicit rather than derived: the
 * earlier version of this file iterated TRACKED_ACTIONS and asserted each was
 * in HUMAN_VERIFICATION_BLOCKED_ACTIONS — which is how HVB is CONSTRUCTED
 * (action-tables.ts spreads TRACKED into it), so the test could not fail.
 * Deleting "act" from TRACKED, or "evaluate" from HVB's extra members, passed.
 */
import { describe, expect, it } from "vitest";
import {
  RESET_ACTIONS,
  TRACKED_ACTIONS,
  READ_ONLY_ACTIONS,
  HUMAN_VERIFICATION_BLOCKED_ACTIONS,
} from "./action-tables.js";

const intersect = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].filter((x) => b.has(x));

describe("browser action tables", () => {
  it("never tracks progress for a read-only action (a read never 'tries to move the page')", () => {
    expect(intersect(TRACKED_ACTIONS, READ_ONLY_ACTIONS)).toEqual([]);
  });

  it("never treats an action as both a context reset and an advancing action", () => {
    expect(intersect(RESET_ACTIONS, TRACKED_ACTIONS)).toEqual([]);
  });

  it("pins the advancing actions that must be progress-tracked", () => {
    expect([...TRACKED_ACTIONS].sort()).toEqual(
      ["act", "click", "click_text", "fill", "scroll", "select"],
    );
  });

  it("pins the actions that establish a fresh page context", () => {
    expect([...RESET_ACTIONS].sort()).toEqual(
      ["close", "close_tab", "emulate", "navigate", "new_tab", "switch_tab"].sort(),
    );
  });

  it("pins every action blocked while a human-verification challenge is up", () => {
    expect([...HUMAN_VERIFICATION_BLOCKED_ACTIONS].sort()).toEqual(
      [
        "act", "click", "click_text", "dialog_accept", "dialog_dismiss", "emulate",
        "evaluate", "fill", "layout_report", "scroll", "select",
      ].sort(),
    );
  });

  it("keeps the escape and re-perceive actions available during verification", () => {
    for (const action of ["snapshot", "observe", "extract", "screenshot", "info", "tabs", "navigate", "switch_tab", "close"]) {
      expect(HUMAN_VERIFICATION_BLOCKED_ACTIONS.has(action)).toBe(false);
    }
  });

  it("blocks exactly one read-only action during verification: the script-executing one", () => {
    expect(intersect(READ_ONLY_ACTIONS, HUMAN_VERIFICATION_BLOCKED_ACTIONS)).toEqual(["layout_report"]);
  });

  it("classifies layout_report read-only and emulate not", () => {
    expect(READ_ONLY_ACTIONS.has("layout_report")).toBe(true);
    expect(READ_ONLY_ACTIONS.has("emulate")).toBe(false);
  });

  it("cannot be mutated by an importer (a deleted member would un-gate an action process-wide)", () => {
    for (const table of [RESET_ACTIONS, TRACKED_ACTIONS, READ_ONLY_ACTIONS, HUMAN_VERIFICATION_BLOCKED_ACTIONS]) {
      const mutable = table as Set<string>;
      expect(() => mutable.delete("evaluate")).toThrow(/immutable/);
      expect(() => mutable.add("anything")).toThrow(/immutable/);
      expect(() => mutable.clear()).toThrow(/immutable/);
    }
    expect(HUMAN_VERIFICATION_BLOCKED_ACTIONS.has("evaluate")).toBe(true);
  });
});

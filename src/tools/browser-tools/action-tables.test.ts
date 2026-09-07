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
import type { ActionTable } from "./action-tables.js";
import {
  RESET_ACTIONS,
  TRACKED_ACTIONS,
  READ_ONLY_ACTIONS,
  HUMAN_VERIFICATION_BLOCKED_ACTIONS,
} from "./action-tables.js";

const intersect = (a: ActionTable, b: ActionTable) => [...a].filter((x) => b.has(x));

const TABLES: [string, ActionTable][] = [
  ["RESET_ACTIONS", RESET_ACTIONS],
  ["TRACKED_ACTIONS", TRACKED_ACTIONS],
  ["READ_ONLY_ACTIONS", READ_ONLY_ACTIONS],
  ["HUMAN_VERIFICATION_BLOCKED_ACTIONS", HUMAN_VERIFICATION_BLOCKED_ACTIONS],
];

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
        "evaluate", "fill", "scroll", "select",
      ].sort(),
    );
  });

  it("keeps the escape and re-perceive actions available during verification", () => {
    for (const action of ["snapshot", "observe", "extract", "screenshot", "info", "tabs", "navigate", "switch_tab", "close"]) {
      expect(HUMAN_VERIFICATION_BLOCKED_ACTIONS.has(action)).toBe(false);
    }
  });

  it("leaves every read-only escape/observation action available during verification", () => {
    expect(intersect(READ_ONLY_ACTIONS, HUMAN_VERIFICATION_BLOCKED_ACTIONS)).toEqual([]);
  });

  it("does not classify emulate as read-only: it destroys and re-mints the session's context", () => {
    expect(READ_ONLY_ACTIONS.has("emulate")).toBe(false);
  });

  // The bypass that defeated the previous "sealed Set": the tables were real
  // Sets with add/delete/clear shadowed as own frozen props, so the OWN methods
  // threw while `Set.prototype.delete.call(TABLE, "evaluate")` and
  // `Set.prototype.clear.call(TABLE)` reached straight past them into
  // [[SetData]] and emptied the human-verification block list process-wide. The
  // old test only called the three shadowed own methods, so it proved the
  // properties it had just defined. These call the prototype methods directly.
  it.each(TABLES)("%s survives the Set.prototype.*.call bypass", (_name, table) => {
    const receiver = table as unknown as Set<string>;
    const members = [...table];
    expect(members.length).toBeGreaterThan(0);

    for (const method of ["delete", "add", "clear"] as const) {
      expect(() => (Set.prototype[method] as (this: unknown, v?: string) => unknown)
        .call(receiver, members[0])).toThrow(TypeError);
    }

    expect([...table]).toEqual(members);
    expect(table.size).toBe(members.length);
    for (const member of members) expect(table.has(member)).toBe(true);
  });

  it("exposes no Set at all — there is no receiver for a prototype method to act on", () => {
    for (const [, table] of TABLES) {
      expect(table).not.toBeInstanceOf(Set);
      expect(Object.isFrozen(table)).toBe(true);
      // Own surface is exactly has/size/@@iterator — no add/delete/clear to
      // shadow, and nothing that hands the backing Set back out.
      expect(Object.getOwnPropertyNames(table).sort()).toEqual(["has", "size"]);
      for (const value of Object.values(table)) expect(value).not.toBeInstanceOf(Set);
    }
  });

  it("keeps evaluate gated after every bypass attempt above", () => {
    expect(HUMAN_VERIFICATION_BLOCKED_ACTIONS.has("evaluate")).toBe(true);
    expect(HUMAN_VERIFICATION_BLOCKED_ACTIONS.size).toBe(10);
  });
});

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
  PAGE_WRITE_ACTIONS,
  PAGE_GET_ACTIONS,
} from "./action-tables.js";
import { BROWSER_TOOL_PARAMETERS } from "./description.js";
import { TOOL_POLICIES } from "../../tool-policy/tool-policies.js";

const intersect = (a: ActionTable, b: ActionTable) => [...a].filter((x) => b.has(x));

const TABLES: [string, ActionTable][] = [
  ["RESET_ACTIONS", RESET_ACTIONS],
  ["TRACKED_ACTIONS", TRACKED_ACTIONS],
  ["READ_ONLY_ACTIONS", READ_ONLY_ACTIONS],
  ["HUMAN_VERIFICATION_BLOCKED_ACTIONS", HUMAN_VERIFICATION_BLOCKED_ACTIONS],
  ["PAGE_WRITE_ACTIONS", PAGE_WRITE_ACTIONS],
  ["PAGE_GET_ACTIONS", PAGE_GET_ACTIONS],
];

/** Every action the model can name — the tool's own schema enum. */
const ENUM_ACTIONS: readonly string[] = (BROWSER_TOOL_PARAMETERS.properties.action as { enum: readonly string[] }).enum;

describe("the kernel's verdict on every browser action", () => {
  // The hand list this derives from had drifted: `type` (not an action) was a
  // write, while click_text, dialog_accept and bookmark_add — each carrying
  // model-chosen bytes into the page or a store — read as gets, so a preset
  // that denies tainted writes never saw them (red team 2026-10-13, B6).
  it("holds every action in the enum in exactly one of PAGE_WRITE / PAGE_GET", () => {
    const unclassified = ENUM_ACTIONS.filter((a) => !PAGE_WRITE_ACTIONS.has(a) && !PAGE_GET_ACTIONS.has(a));
    expect(unclassified, "every browser action needs a kernel verdict in action-tables.ts").toEqual([]);
    expect(intersect(PAGE_WRITE_ACTIONS, PAGE_GET_ACTIONS)).toEqual([]);
    const notActions = [...PAGE_WRITE_ACTIONS, ...PAGE_GET_ACTIONS].filter((a) => !ENUM_ACTIONS.includes(a));
    expect(notActions, "a verdict for a name the tool does not accept is dead").toEqual([]);
  });

  it("pins the writes: every action whose bytes reach the page or commit state", () => {
    expect([...PAGE_WRITE_ACTIONS].sort()).toEqual(
      ["act", "bookmark_add", "click", "click_text", "dialog_accept", "evaluate", "fill", "release_download", "select"],
    );
  });

  it("judges every read-only action and every context reset as a get", () => {
    for (const a of [...READ_ONLY_ACTIONS, ...RESET_ACTIONS]) expect(PAGE_GET_ACTIONS.has(a), a).toBe(true);
    expect(PAGE_WRITE_ACTIONS.has("emulate")).toBe(false);
  });

  it("is what the browser's policy row hands the kernel, not a second copy", () => {
    const spec = TOOL_POLICIES.browser.ariAction;
    expect(typeof spec).toBe("object");
    const { arg, writes, as } = spec as { arg: string; writes: readonly string[]; as?: string };
    expect(arg).toBe("action");
    expect(as).toBe("post");
    expect([...writes].sort()).toEqual([...PAGE_WRITE_ACTIONS].sort());
  });
});

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

  it("blocks exactly ONE read-only action during verification: layout_report, which runs script in the challenge page", () => {
    expect(intersect(READ_ONLY_ACTIONS, HUMAN_VERIFICATION_BLOCKED_ACTIONS)).toEqual(["layout_report"]);
  });

  it("classifies layout_report read-only and emulate not (emulate destroys and re-mints the session's context)", () => {
    expect(READ_ONLY_ACTIONS.has("layout_report")).toBe(true);
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
    expect(HUMAN_VERIFICATION_BLOCKED_ACTIONS.size).toBe(11);
  });
});

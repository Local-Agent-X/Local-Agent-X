import { describe, expect, it } from "vitest";
import { FLIPPABLE_SETTINGS, PROTECTED_SETTINGS, SPENDING_CAP_SETTINGS } from "./settings-schema.js";
import {
  PROTECTED_TIGHTENING,
  PROTECTED_WITHOUT_SAFE_DIRECTION,
  isUserOwnedSetting,
  strictlyTightens,
} from "./settings-change-direction.js";

const spec = (field: string) => FLIPPABLE_SETTINGS.find((s) => s.field === field)!;

describe("every protected setting has a decided direction", () => {
  it("is either given a narrowing change or listed as having none, never both", () => {
    const decided = [...Object.keys(PROTECTED_TIGHTENING), ...PROTECTED_WITHOUT_SAFE_DIRECTION];
    expect(decided.sort()).toEqual([...PROTECTED_SETTINGS].sort());
    expect(new Set(decided).size).toBe(decided.length);
  });

  it("names only values the schema accepts, and orders every value of an ordered field", () => {
    for (const [field, rule] of Object.entries(PROTECTED_TIGHTENING)) {
      const validate = spec(field).validate;
      if ("safe" in rule) {
        expect(validate.safeParse(rule.safe).success, `${field} safe value`).toBe(true);
        continue;
      }
      for (const v of rule.stricterLast) expect(validate.safeParse(v).success, `${field} ${v}`).toBe(true);
      const values = (validate as unknown as { _def: { values: string[] } })._def.values;
      expect([...rule.stricterLast].sort(), field).toEqual([...values].sort());
    }
  });
});

describe("the spending caps", () => {
  it("are settings the schema defines, and every budget setting is one of them", () => {
    for (const field of SPENDING_CAP_SETTINGS) expect(spec(field), field).toBeDefined();
    const budgets = FLIPPABLE_SETTINGS.filter((s) => /budget/i.test(s.field)).map((s) => s.field);
    expect(budgets.sort()).toEqual([...SPENDING_CAP_SETTINGS].sort());
  });

  it("are user-owned like the protected settings", () => {
    for (const field of [...SPENDING_CAP_SETTINGS, ...PROTECTED_SETTINGS]) expect(isUserOwnedSetting(field), field).toBe(true);
    expect(isUserOwnedSetting("theme")).toBe(false);
  });

  it("narrow only when every cap ends at or under where it was", () => {
    expect(strictlyTightens("dailyBudgetUsd", 10, () => 0)).toBe(true);
    expect(strictlyTightens("dailyBudgetUsd", 0, () => 0)).toBe(true);
    expect(strictlyTightens("dailyBudgetUsd", 0, () => 10)).toBe(false);
    expect(strictlyTightens("dailyBudgetUsd", -1, () => 10)).toBe(false);
    expect(strictlyTightens("dailyBudgetUsd", "5", () => 10)).toBe(false);
    expect(strictlyTightens("modelDailyBudgetsUsd", { a: 1 }, () => ({}))).toBe(true);
    expect(strictlyTightens("modelDailyBudgetsUsd", {}, () => ({ a: 0 }))).toBe(true);
    expect(strictlyTightens("modelDailyBudgetsUsd", { a: "1" }, () => ({}))).toBe(false);
    expect(strictlyTightens("modelDailyBudgetsUsd", [], () => ({}))).toBe(false);
  });
});

describe("a value the module cannot place counts as widening", () => {
  it("for an ordered field whose current value is unknown", () => {
    expect(strictlyTightens("toolApproval", "confirm-all", () => undefined)).toBe(false);
    expect(strictlyTightens("toolApproval", "never", () => "auto")).toBe(false);
  });

  it("for a kill-switch given anything but its off value", () => {
    expect(strictlyTightens("enableShell", "false", () => true)).toBe(false);
    expect(strictlyTightens("enableShell", 0, () => true)).toBe(false);
  });

  it("for a setting that is not user-owned", () => {
    expect(strictlyTightens("theme", "light", () => "dark")).toBe(false);
  });
});

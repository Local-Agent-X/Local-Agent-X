/**
 * What a deck is for decides its rules: the measurable ones here, the
 * judgment ones in a playbook per purpose in the skills system. Each purpose
 * must have both, or the agent reviews a pitch against nothing.
 */
import { describe, expect, it } from "vitest";
import { DECK_PURPOSES, DECK_PURPOSE_NAMES, PURPOSE_PARAM_SCHEMA, deckLimits, loadPlaybook, playbookName } from "./deck-purposes.js";
import { OFFICE_DESIGN_NAMES } from "./office-designs.js";

describe("deck purposes", () => {
  for (const purpose of DECK_PURPOSE_NAMES) {
    it(`${purpose} has a playbook in the skills catalog`, async () => {
      const body = await loadPlaybook(purpose);
      expect(body, playbookName(purpose)).toBeTruthy();
      expect(body!).toMatch(/\*\*Audience:\*\*/);
      expect(body!).toMatch(/\*\*Review the rendered deck:\*\*/);
    });
  }

  it("name only designs that exist", () => {
    for (const p of DECK_PURPOSE_NAMES) for (const d of DECK_PURPOSES[p].designs) expect(OFFICE_DESIGN_NAMES, `${p} → ${d}`).toContain(d);
  });

  it("give a read-alone report room a projected pitch does not get, and kids the largest type", () => {
    expect(deckLimits("report").maxWords).toBeGreaterThan(deckLimits("pitch").maxWords * 3);
    expect(Math.max(...DECK_PURPOSE_NAMES.map((p) => DECK_PURPOSES[p].minTextPt))).toBe(DECK_PURPOSES.kids.minTextPt);
  });

  it("fall back to general limits for no purpose or an unknown one", () => {
    expect(deckLimits(undefined)).toEqual({ maxWords: 75, maxBullets: 6 });
    expect(deckLimits("haiku")).toEqual({ maxWords: 75, maxBullets: 6 });
  });

  it("are listed in the parameter with what each is for and its designs", () => {
    expect(PURPOSE_PARAM_SCHEMA.enum).toEqual(DECK_PURPOSE_NAMES);
    expect(PURPOSE_PARAM_SCHEMA.description).toMatch(/legal: legal, compliance, policy or governance \(designs: ledger\/graphite\)/);
  });
});

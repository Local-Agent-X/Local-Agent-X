import { describe, it, expect } from "vitest";
import { namesSameSubject } from "./same-subject.js";

const said = (content: string, entities: string[] = []) => ({ content, entities });

describe("namesSameSubject", () => {
  it("refuses when the newer statement never names what the older fact is about", () => {
    expect(namesSameSubject({ entities: ["reta", "u-100"] }, said("User's semaglutide vial is 50mg on a U-100 syringe", ["u-100"]), [])).toBe(false);
  });

  it("accepts a name by tag, by words in any spacing, or by a prefix of a longer name", () => {
    expect(namesSameSubject({ entities: ["reta"] }, said("new vial", ["reta"]), [])).toBe(true);
    expect(namesSameSubject({ entities: ["bpc-157"] }, said("my bpc 157 is now 10 mg"), [])).toBe(true);
    expect(namesSameSubject({ entities: ["reta"] }, said("retatrutide is now 50 mg"), [])).toBe(true);
    expect(namesSameSubject({ entities: ["retatrutide"] }, said("reta is now 50 mg"), [])).toBe(true);
  });

  it("counts the user's own name as named, since facts call them by name or \"the user\"", () => {
    expect(namesSameSubject({ entities: ["peter", "reta"] }, said("User's reta vial is 50 mg"), ["Peter"])).toBe(true);
    expect(namesSameSubject({ entities: ["peter", "reta"] }, said("User's reta vial is 50 mg"), [])).toBe(false);
  });

  it("does not stretch a short or hyphenated name by prefix", () => {
    expect(namesSameSubject({ entities: ["art"] }, said("starting art classes"), [])).toBe(true);
    expect(namesSameSubject({ entities: ["art"] }, said("artichoke season"), [])).toBe(false);
    expect(namesSameSubject({ entities: ["u-100"] }, said("u syringe"), [])).toBe(false);
  });

  it("a fact filed under nothing can be replaced as before", () => {
    expect(namesSameSubject({ entities: [] }, said("anything"), [])).toBe(true);
  });
});

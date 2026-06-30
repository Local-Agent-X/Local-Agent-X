import { describe, it, expect } from "vitest";
import { looseNameMatch, resolvePinToUnpin } from "./sidebar.js";

describe("looseNameMatch", () => {
  it("matches case-insensitively and on substring either way", () => {
    expect(looseNameMatch("Dinosaur Todo App", "dinosaur todo")).toBe(true);
    expect(looseNameMatch("dinosaur todo", "Dinosaur Todo App")).toBe(true);
    expect(looseNameMatch("Calculator", "calculator")).toBe(true);
  });

  it("does not match unrelated names", () => {
    expect(looseNameMatch("Calculator", "weather")).toBe(false);
  });
});

describe("resolvePinToUnpin", () => {
  const pins = ["Dinosaur Todo App", "Weather", "Calculator"];

  it("resolves a partial reference to the stored pin", () => {
    // The exact-match filter that shipped before returned no match here, so
    // unpin reported the app wasn't pinned when it was. It now resolves.
    expect(resolvePinToUnpin(pins, "dinosaur todo")).toEqual({ kind: "match", name: "Dinosaur Todo App" });
  });

  it("still resolves an exact name", () => {
    expect(resolvePinToUnpin(pins, "Weather")).toEqual({ kind: "match", name: "Weather" });
  });

  it("prefers the exact match over a longer pin that contains it", () => {
    expect(resolvePinToUnpin(["Todo", "Todo App"], "todo")).toEqual({ kind: "match", name: "Todo" });
  });

  it("reports ambiguity instead of guessing when a partial hits multiple pins", () => {
    expect(resolvePinToUnpin(["Todo App", "Todo Archive"], "todo")).toEqual({
      kind: "ambiguous",
      candidates: ["Todo App", "Todo Archive"],
    });
  });

  it("returns none when nothing matches", () => {
    expect(resolvePinToUnpin(pins, "spreadsheet")).toEqual({ kind: "none" });
  });
});

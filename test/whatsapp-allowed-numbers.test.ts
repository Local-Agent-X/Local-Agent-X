import { describe, it, expect } from "vitest";
import { sanitizeNumbers } from "../src/whatsapp-bridge/allowed-numbers.js";

describe("sanitizeNumbers", () => {
  it("strips non-digit characters", () => {
    const out = sanitizeNumbers(["+1 (234) 567-8901"]);
    expect([...out]).toEqual(["12345678901"]);
  });

  it("rejects numbers shorter than 7 digits", () => {
    expect(sanitizeNumbers(["123456"]).size).toBe(0);
  });

  it("rejects numbers longer than 15 digits", () => {
    expect(sanitizeNumbers(["1234567890123456"]).size).toBe(0);
  });

  it("keeps numbers at the 7 and 15 digit boundaries", () => {
    const out = sanitizeNumbers(["1234567", "123456789012345"]);
    expect(out.has("1234567")).toBe(true);
    expect(out.has("123456789012345")).toBe(true);
  });

  it("dedupes equal numbers after sanitizing", () => {
    const out = sanitizeNumbers(["+1 234 567 8901", "12345678901"]);
    expect(out.size).toBe(1);
  });

  it("drops an entry that sanitizes to empty", () => {
    expect(sanitizeNumbers(["", "----"]).size).toBe(0);
  });
});

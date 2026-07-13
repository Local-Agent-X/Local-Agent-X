import { describe, it, expect } from "vitest";
import { classifyData, luhnValid } from "./classification.js";

describe("luhnValid", () => {
  it.each([
    "4532015112830366", // Visa test number, valid checksum
    "5425233430109903", // Mastercard test number
    "374245455400126",  // Amex test number
    "4532 0151 1283 0366",
    "4532-0151-1283-0366",
  ])("accepts %s", (n) => {
    expect(luhnValid(n)).toBe(true);
  });

  it.each([
    "4532015112830367", // checksum off by one
    "1234567812345678", // arbitrary 16 digits
    "411111111111",     // too short (12)
    "45320151128303661234", // too long (20)
    "4532abcd12830366", // non-digit
  ])("rejects %s", (n) => {
    expect(luhnValid(n)).toBe(false);
  });
});

describe("classifyData — financial label requires a Luhn-valid PAN", () => {
  it("labels a real card number as financial", () => {
    const c = classifyData("card on file: 4532015112830366, exp 09/28");
    expect(c.labels).toContain("financial");
  });

  it("labels a spaced card number as financial", () => {
    const c = classifyData("pay with 5425 2334 3010 9903 please");
    expect(c.labels).toContain("financial");
  });

  it("does NOT label a Luhn-invalid 16-digit run (order/tracking ids)", () => {
    const c = classifyData("tracking number 4532015112830367 shipped today");
    expect(c.labels).not.toContain("financial");
  });

  it("finds a valid PAN even after an invalid candidate earlier in the text", () => {
    const c = classifyData("ref 4111111111111112 then card 4532015112830366");
    expect(c.labels).toContain("financial");
  });

  it("is not stateful across calls (global regex lastIndex reset)", () => {
    const text = "card 4532015112830366";
    expect(classifyData(text).labels).toContain("financial");
    expect(classifyData(text).labels).toContain("financial");
  });
});

// The generic Key-Value rule reads `token = <value>` as a credential. In code
// the right-hand side is often an expression computing the value, and three
// such lines refused the write of a TV remote's pairing modules (Vizio and
// Samsung, 2026-11-20). An expression is not a value; a literal still is.
import { describe, it, expect } from "vitest";
import { scanForSecrets } from "./secret-scanner.js";

const keyValueHits = (text: string) => scanForSecrets(text).matches.filter((m) => m.pattern === "Key-Value Secret");

describe("Key-Value Secret and code", () => {
  it.each([
    ["a template interpolation", "url += `&token=${encodeURIComponent(saved.token)}`;"],
    ["a call", "if (key) { saved.token = String(key); save(); }"],
    ["a property read", "{ CHALLENGE_TYPE: pairing.challenge, PAIRING_REQ_TOKEN: pairing.token, }"],
    ["a call on a path", "const password = process.env.getPassword();"],
  ])("is not raised by %s", (_shape, line) => {
    expect(keyValueHits(line)).toEqual([]);
  });

  it.each([
    ["an unquoted literal", "token=Zx9qR2mWv7LkP4tY8nHc"],
    ["a quoted literal", 'api_key: "Zx9qR2mWv7LkP4tY8nHc"'],
    ["a dotted key with digits", "token = pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJ4In0"],
    ["a password that only starts like a name", "password=Summer2026Rocks!"],
  ])("still catches %s", (_shape, line) => {
    expect(scanForSecrets(line).clean).toBe(false);
  });
});

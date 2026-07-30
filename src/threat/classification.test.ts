import { describe, it, expect } from "vitest";
import { classifyData, luhnValid, stripExternalUntrusted } from "./classification.js";

describe("stripExternalUntrusted — inbound third-party content is not the session's own output", () => {
  it("removes a whole external block so its example credentials don't classify", () => {
    const wrapped =
      '<<<EXTERNAL_UNTRUSTED_CONTENT id="z1">>>\nAuthorization: Bearer abc123def456\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="z1">>>';
    expect(classifyData(wrapped).labels).toContain("credentials");
    expect(classifyData(stripExternalUntrusted(wrapped)).labels).not.toContain("credentials");
  });

  it("removes a truncated (unterminated) external block too", () => {
    const truncated = 'ok\n<<<EXTERNAL_UNTRUSTED_CONTENT id="z2">>>\napi_key: sk-aaaaaaaaaaaaaaaa and the response was cut off';
    expect(stripExternalUntrusted(truncated).trim()).toBe("ok");
  });

  it("leaves unwrapped content untouched (a local secret-file read still classifies)", () => {
    const local = '{ "apiKey": "sk-abcdefghijklmnopqrstuv" }';
    expect(stripExternalUntrusted(local)).toBe(local);
    expect(classifyData(stripExternalUntrusted(local)).labels).toContain("credentials");
  });
});

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

// Regression (2026-07-29 false-positive audit): the key-value credential pattern
// fired on any `token: <8+ chars>`, so ORDINARY APP SOURCE was classified as a
// credential leak — and each hit scores credential_in_output (30), on its own
// enough to restrict the whole session's external calls. 13 such blocks in three
// days while the agent built an app around a Clover connector. Measured: 8 of 12
// realistic source lines tripped it.
describe("key-value credential assignments — declaration vs live secret", () => {
  const flagged = (t: string) => {
    const l = classifyData(t).labels;
    return l.includes("credentials") || l.includes("secrets");
  };

  // Each of these is a DECLARATION, not a secret. Every one was a live block.
  it.each([
    ["env reference", `token: process.env.CLOVER_TOKEN`],
    ["env reference (assignment form)", `const apiKey = process.env.VITE_CLOVER_API_KEY;`],
    ["python env reference", `password = os.environ["DB_PASSWORD"]`],
    ["zod schema", `password: z.string().min(8).max(72)`],
    ["call expression", `token: getAccessToken()`],
    ["upper placeholder", `apiKey: "YOUR_API_KEY_HERE"`],
    ["replace-me placeholder", `client_secret: "REPLACE_ME_BEFORE_DEPLOY"`],
    ["angle placeholder", `api_key: "<your-key>"`],
    ["doc-comment placeholder", `# password: changeme-please-set-this`],
    ["undefined literal", `secret: undefined,`],
    ["already masked", `"password": "[REDACTED]"`],
    ["shell var", `token: $CLOVER_TOKEN`],
    ["windows var", `token: %CLOVER_TOKEN%`],
  ])("does NOT classify a %s as a credential", (_what, text) => {
    expect(flagged(text)).toBe(false);
  });

  // The other half of the contract: real secrets must still be caught. If this
  // block ever goes green-by-suppression the guard has eaten the detector.
  it.each([
    ["stripe-style key", `api_key: "sk_live_51H8xQ2eZvKYlo2C9abcdefgh"`],
    ["github PAT", `token: "ghp_16C7e42F292c6912E7710c838347Ae178B4a"`],
    ["plain password", `password: "hunter2hunter2hunter2"`],
    ["password containing parens", `password: "Tr0ub4dor&3(x)"`],
    // Guard regression: an UNANCHORED /your/ excused this real-shaped token
    // because the value contains "yourcompany". Placeholder words must anchor to
    // the value start, so this stays caught.
    ["real token whose value contains 'your'", `token: "sk_live_yourcompany_9f8e7d6c5b4a"`],
  ])("STILL classifies a %s", (_what, text) => {
    expect(flagged(text)).toBe(true);
  });

  // matchAll + the `g` flag: a placeholder earlier in the content must not mask a
  // real assignment later in it. Without `g` on a validated pattern, the first
  // non-live match would end the scan.
  it("a placeholder does not mask a real credential later in the same content", () => {
    const content = [
      `// apiKey: "YOUR_API_KEY_HERE"`,
      `const cfg = { token: process.env.TOKEN };`,
      `password: "hunter2hunter2hunter2"`,
    ].join("\n");
    expect(flagged(content)).toBe(true);
  });

  it("scopes the guard to scoring: the REDACTION catalog still masks placeholders", async () => {
    // The asymmetry is deliberate. Masking a placeholder costs nothing; missing a
    // real secret in redaction is a leak. So credential-patterns.ts stays
    // unguarded and must keep redacting a declaration the scorer now ignores.
    const { redact } = await import("../security/secrets/credential-patterns.js");
    expect(flagged(`apiKey: "YOUR_API_KEY_HERE"`)).toBe(false);
    expect(redact(`apiKey: "YOUR_API_KEY_HERE"`)).toContain("REDACTED");
  });
});

// Regression (2026-07-29): two copies of "what key names make this a credential
// assignment" had drifted. The REDACTION catalog listed authorization /
// access_key / private_key; the SCORING classifier here did not. Net effect: a raw
// `AWS_SECRET_ACCESS_KEY=…` was masked out of the model's view but never scored —
// hidden, yet never raising the alarm the scoring exists for. Both now build their
// pattern from CREDENTIAL_KEY_NAMES.
describe("credential key names are ONE list, shared with the redaction catalog", () => {
  const flagged = (t: string) => classifyData(t).labels.includes("credentials");

  it.each([
    ["access_key (the key that was missing — real AWS secret shape)", `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENGbPxRfiCYzzzzzzzz`],
    ["authorization", `authorization=abcdef0123456789abcdef`],
    ["private_key", `private_key=MIIEvQIBADANBgkqhkiG9w0BAQEFAASC`],
  ])("now SCORES a live %s assignment", (_what, text) => {
    expect(flagged(text)).toBe(true);
  });

  it("scoring and redaction recognise the SAME key names", async () => {
    const { CREDENTIAL_KEY_NAMES, CREDENTIAL_PATTERNS } = await import("../security/secrets/credential-patterns.js");
    // The redaction catalog's key-value entry must be built from the shared list —
    // if someone re-inlines a literal alternation there, this fails.
    const kv = CREDENTIAL_PATTERNS.find((p) => p.name === "Key-Value Secret");
    expect(kv, "the Key-Value Secret entry should still exist").toBeDefined();
    expect(kv!.regex.source).toContain(CREDENTIAL_KEY_NAMES);

    // ...and every key in the shared list must actually score here, with a live
    // value. A key present in the list but unrecognised by scoring is the exact
    // drift this test exists to catch.
    for (const key of CREDENTIAL_KEY_NAMES.split("|")) {
      const literal = key.replace(/\[_-\]\?/g, "_");   // api[_-]?key -> api_key
      expect(flagged(`${literal}=wJalrXUtnFEMIK7MDENGbPxRfiCY`), `${literal} should score`).toBe(true);
    }
  });

  it("the guard still applies to the newly-shared keys (declarations stay clean)", () => {
    // Widening the key list must not re-open the false positive it sits beside.
    expect(flagged(`authorization: process.env.AUTH_HEADER`)).toBe(false);
    expect(flagged(`access_key: "YOUR_ACCESS_KEY_HERE"`)).toBe(false);
    expect(flagged(`private_key: undefined,`)).toBe(false);
  });
});

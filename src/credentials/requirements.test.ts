import { describe, expect, it } from "vitest";
import {
  isSecretRequirement,
  missingCredentials,
  parseCredentialRequirements,
  type CredentialRequirement,
  type SecretAvailabilityPort,
} from "./requirements.js";

function port(...available: string[]): SecretAvailabilityPort {
  const names = new Set(available);
  return { has: (name) => names.has(name) };
}

describe("credential requirement names", () => {
  it("accepts canonical names and omits absent optional fields", () => {
    expect(parseCredentialRequirements([{ name: "A" }, { name: "PLUGIN_TOKEN2" }]))
      .toEqual([{ name: "A" }, { name: "PLUGIN_TOKEN2" }]);
    expect(parseCredentialRequirements([{ name: "TOKEN", service: "Example", description: "A token" }]))
      .toEqual([{ name: "TOKEN", service: "Example", description: "A token" }]);
    expect(Object.keys(parseCredentialRequirements([{ name: "TOKEN" }])![0])).toEqual(["name"]);
  });

  it("rejects non-canonical names", () => {
    for (const name of ["plugin_token", "1TOKEN", "_TOKEN", "PLUGIN-TOKEN", "PLUGIN TOKEN", ""]) {
      expect(() => parseCredentialRequirements([{ name }])).toThrow("must be canonical");
    }
    expect(() => parseCredentialRequirements([{ name: 42 }])).toThrow("must be canonical");
    // 64 chars is the ceiling: one leading letter plus 63 more.
    expect(parseCredentialRequirements([{ name: `A${"B".repeat(63)}` }])).toHaveLength(1);
    expect(() => parseCredentialRequirements([{ name: `A${"B".repeat(64)}` }])).toThrow("must be canonical");
  });

  it("rejects duplicate names", () => {
    expect(() => parseCredentialRequirements([{ name: "TOKEN" }, { name: "TOKEN" }]))
      .toThrow("duplicate secret requirements");
    expect(() => parseCredentialRequirements([{ name: "TOKEN" }, { name: "OTHER" }])).not.toThrow();
  });

  it("rejects malformed declarations", () => {
    expect(parseCredentialRequirements(undefined)).toBeUndefined();
    expect(() => parseCredentialRequirements([])).toThrow("non-empty array");
    expect(() => parseCredentialRequirements({ name: "TOKEN" })).toThrow("non-empty array");
    expect(() => parseCredentialRequirements([null])).toThrow("must be an object");
    expect(() => parseCredentialRequirements([["TOKEN"]])).toThrow("must be an object");
    expect(() => parseCredentialRequirements([{ name: "TOKEN", optional: true }])).toThrow("unknown field");
    expect(() => parseCredentialRequirements([{ name: "TOKEN", service: "  " }])).toThrow("service is invalid");
    expect(() => parseCredentialRequirements([{ name: "TOKEN", description: 7 }])).toThrow("description is invalid");
  });

  it("does not admit the declaration-only fields into the plugin bundle contract", () => {
    // `secret` and `url` exist on the type for the integrations use case; the
    // parser must stay exactly as strict as it was before the lift.
    expect(() => parseCredentialRequirements([{ name: "TOKEN", secret: false }])).toThrow("unknown field");
    expect(() => parseCredentialRequirements([{ name: "TOKEN", url: "https://example.com" }])).toThrow("unknown field");
  });
});

describe("credential requirement fields", () => {
  it("treats a requirement as a secret unless it opts out", () => {
    const bare: CredentialRequirement = { name: "TOKEN" };
    expect(bare.secret).toBeUndefined();
    expect(bare.url).toBeUndefined();
    expect(isSecretRequirement(bare)).toBe(true);
    expect(isSecretRequirement({ name: "TOKEN", secret: true })).toBe(true);
    expect(isSecretRequirement({ name: "SMTP_HOST", secret: false })).toBe(false);
  });

  it("carries an acquisition url when one is declared", () => {
    const withUrl: CredentialRequirement = { name: "TOKEN", url: "https://example.com/tokens" };
    expect(withUrl.url).toBe("https://example.com/tokens");
    expect(isSecretRequirement(withUrl)).toBe(true);
  });
});

describe("missing credential derivation", () => {
  const requirements: CredentialRequirement[] = [
    { name: "ONE" },
    { name: "TWO", secret: false },
    { name: "THREE" },
  ];

  it("reports the names the port cannot satisfy, in declaration order", () => {
    expect(missingCredentials(requirements, port("TWO"))).toEqual(["ONE", "THREE"]);
    expect(missingCredentials(requirements, port("ONE", "TWO", "THREE"))).toEqual([]);
  });

  it("treats an unbound port as satisfying nothing", () => {
    expect(missingCredentials(requirements, undefined)).toEqual(["ONE", "TWO", "THREE"]);
    expect(missingCredentials([], undefined)).toEqual([]);
  });

  it("does not exempt non-secret requirements from the availability check", () => {
    expect(missingCredentials([{ name: "SMTP_HOST", secret: false }], port())).toEqual(["SMTP_HOST"]);
  });
});

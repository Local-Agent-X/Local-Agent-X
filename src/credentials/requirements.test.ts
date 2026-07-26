import { describe, expect, it } from "vitest";
import {
  isRequiredRequirement,
  isSecretRequirement,
  missingCredentials,
  missingSecretCredentials,
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
    // `secret`, `url` and `required` exist on the type for the integrations use
    // case; the parser must stay exactly as strict as it was before the lift.
    // Admitting `required` would let a bundle declare a secret it can run
    // without, which is a manifest-contract change and not this chunk's.
    expect(() => parseCredentialRequirements([{ name: "TOKEN", secret: false }])).toThrow("unknown field");
    expect(() => parseCredentialRequirements([{ name: "TOKEN", url: "https://example.com" }])).toThrow("unknown field");
    expect(() => parseCredentialRequirements([{ name: "TOKEN", required: false }])).toThrow("unknown field");
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

  it("treats a requirement as required unless it opts out", () => {
    // Same shape as `secret`: absent means true, so declaring the field narrows
    // nothing until a declaration opts in. The two are INDEPENDENT — email's
    // IMAP_PASS is a secret the user may legitimately not have (send-only), and
    // its SMTP_HOST is a non-secret the user must supply.
    const bare: CredentialRequirement = { name: "TOKEN" };
    expect(bare.required).toBeUndefined();
    expect(isRequiredRequirement(bare)).toBe(true);
    expect(isRequiredRequirement({ name: "TOKEN", required: true })).toBe(true);
    expect(isRequiredRequirement({ name: "IMAP_PASS", required: false })).toBe(false);
    expect(isSecretRequirement({ name: "IMAP_PASS", required: false })).toBe(true);
    expect(isRequiredRequirement({ name: "SMTP_HOST", secret: false })).toBe(true);
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
    // missingCredentials() is the PURE presence check: it reports on exactly the
    // list it is handed and makes no judgement about what belongs in the vault.
    // The judgement lives in missingSecretCredentials() below — one rule, one
    // place, so the integrations gate and the plugin gate cannot diverge.
    expect(missingCredentials([{ name: "SMTP_HOST", secret: false }], port())).toEqual(["SMTP_HOST"]);
  });
});

describe("missing SECRET credential derivation", () => {
  const requirements: CredentialRequirement[] = [
    { name: "ONE" },
    { name: "SMTP_HOST", secret: false },
    { name: "THREE", secret: true },
  ];

  it("ignores requirements that opted out of the vault", () => {
    // The whole point: a `secret: false` value is never stored encrypted, so its
    // absence is the normal state and must never block a gate. This is the exact
    // pair the pure check disagrees with — see the test above.
    expect(missingSecretCredentials([{ name: "SMTP_HOST", secret: false }], port())).toEqual([]);
    expect(missingCredentials([{ name: "SMTP_HOST", secret: false }], port())).toEqual(["SMTP_HOST"]);
  });

  it("reports the absent secret names, in declaration order", () => {
    expect(missingSecretCredentials(requirements, port("SMTP_HOST"))).toEqual(["ONE", "THREE"]);
    expect(missingSecretCredentials(requirements, port("ONE"))).toEqual(["THREE"]);
    expect(missingSecretCredentials(requirements, port("ONE", "THREE"))).toEqual([]);
  });

  it("still requires a secret the port cannot satisfy even when every non-secret is present", () => {
    expect(missingSecretCredentials(requirements, port("SMTP_HOST", "ONE"))).toEqual(["THREE"]);
  });

  it("treats an unbound port as satisfying nothing, minus the opted-out values", () => {
    expect(missingSecretCredentials(requirements, undefined)).toEqual(["ONE", "THREE"]);
    expect(missingSecretCredentials([], undefined)).toEqual([]);
    expect(missingSecretCredentials([{ name: "SMTP_HOST", secret: false }], undefined)).toEqual([]);
  });

  it("ignores a secret the integration can run without", () => {
    // The send-only email user: SMTP_PASS is in the vault, IMAP_PASS is not and
    // never will be. A gate that counts it advertises nothing at all for a
    // perfectly working mailbox. `required: false` is what says the integration
    // still works without it — the value is a SECRET (so the install path still
    // encrypts it when supplied), it is simply not a precondition.
    const optionalSecret: CredentialRequirement[] = [{ name: "SMTP_PASS" }, { name: "IMAP_PASS", required: false }];

    expect(missingSecretCredentials(optionalSecret, port("SMTP_PASS"))).toEqual([]);
    expect(missingSecretCredentials(optionalSecret, port())).toEqual(["SMTP_PASS"]);
    // The pure presence check keeps reporting it: "is it there" and "does its
    // absence block" are different questions, and only the second is relaxed.
    expect(missingCredentials(optionalSecret, port("SMTP_PASS"))).toEqual(["IMAP_PASS"]);
  });

  it("still counts a required secret that also opted out of nothing else", () => {
    // `required: true` written out must behave exactly like absent, or the
    // default and the explicit value have quietly become two rules.
    expect(missingSecretCredentials([{ name: "ONE", required: true }], port())).toEqual(["ONE"]);
    expect(missingSecretCredentials([{ name: "ONE" }], port())).toEqual(["ONE"]);
    // Optional AND non-secret is not a third state: it is ignored for both
    // reasons, and neither reason is allowed to become the only one.
    expect(missingSecretCredentials([{ name: "SMTP_HOST", secret: false, required: false }], port())).toEqual([]);
  });
});

/**
 * The seam test. "Which requirements count against the vault" was briefly TWO
 * rules — the integrations agent-context gate filtered locally while the plugin
 * secret gate did not — which is the divergence this shared module exists to
 * remove. Both now consume missingSecretCredentials(), and this pins it from
 * the plugin side; src/integrations/registry.test.ts pins the other side.
 *
 * No plugin manifest can reach this shape TODAY: parseCredentialRequirements()
 * rejects any field outside name/service/description, so `secret: false` cannot
 * be declared in a bundle (asserted below so the claim cannot rot). The
 * manifest is therefore built directly — the type has always allowed it, and a
 * seam that only holds while one side is unreachable is not a seam.
 */
describe("the plugin secret gate consumes the shared vault-backed rule", () => {
  it("does not block a plugin on a requirement that opted out of the vault", async () => {
    const { missingSecrets } = await import("../plugin-system/secret-requirements.js");
    const manifest = {
      id: "acme", name: "Acme", version: "1.0.0", description: "", entryPoint: "index.js",
      tools: ["acme_ping"],
      contributions: { secrets: [{ name: "ACME_TOKEN" }, { name: "SMTP_HOST", secret: false }] },
    };

    expect(missingSecrets(manifest, port("ACME_TOKEN"))).toEqual([]);
    expect(missingSecrets(manifest, port())).toEqual(["ACME_TOKEN"]);
  });

  it("applies the same rule on the lifecycle path that feeds the plugin list UI", async () => {
    // A second call site, so a second chance to diverge: PluginSecretLifecycle
    // .missing() is what buildPluginList() renders "requires secrets: …" from.
    const { PluginSecretLifecycle } = await import("../plugin-system/secret-requirements.js");
    const lifecycle = new PluginSecretLifecycle();
    lifecycle.bind(port("ACME_TOKEN"));

    expect(lifecycle.missing([{ name: "ACME_TOKEN" }, { name: "SMTP_HOST", secret: false }])).toEqual([]);
    expect(lifecycle.missing([{ name: "OTHER" }, { name: "SMTP_HOST", secret: false }])).toEqual(["OTHER"]);
  });

  it("cannot yet be reached through a real bundle, which is why this is a no-op today", () => {
    expect(() => parseCredentialRequirements([{ name: "SMTP_HOST", secret: false }])).toThrow("unknown field");
  });
});

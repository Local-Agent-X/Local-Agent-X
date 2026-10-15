// Each registered value carries who vouches for it. A vault entry withdraws
// only its own claim on delete or overwrite; a value some channel has already
// treated as a secret (masked out of output, typed into a page) stays one.
// Before sources, unregisterRedactedSecretValue existed for "rotation or
// deletion" but nothing called it: a deleted vault secret stayed masked and
// egress-blocked for the life of the process.
import { afterEach, describe, expect, it } from "vitest";
import { knownSecretValues, registerRedactedSecretValue, unregisterRedactedSecretValue, vaultSecretSource } from "./known-secrets.js";

const V = "Vault-Held-Secret-Value-9x7";
const SOURCES = ["seen", vaultSecretSource("A"), vaultSecretSource("B")];

afterEach(() => { for (const s of SOURCES) unregisterRedactedSecretValue(V, s); });

describe("a registered value stays while any source vouches for it", () => {
  it("leaves only when the last vault entry holding it withdraws", () => {
    registerRedactedSecretValue(V, vaultSecretSource("A"));
    registerRedactedSecretValue(V, vaultSecretSource("B"));
    unregisterRedactedSecretValue(V, vaultSecretSource("A"));
    expect(knownSecretValues()).toContain(V);
    unregisterRedactedSecretValue(V, vaultSecretSource("B"));
    expect(knownSecretValues()).not.toContain(V);
  });

  it("outlives the vault entry when a channel has also treated it as a secret", () => {
    registerRedactedSecretValue(V, vaultSecretSource("A"));
    registerRedactedSecretValue(V);
    unregisterRedactedSecretValue(V, vaultSecretSource("A"));
    expect(knownSecretValues()).toContain(V);
  });

  it("an unregister without a source cannot pull a value the vault still holds", () => {
    registerRedactedSecretValue(V, vaultSecretSource("A"));
    unregisterRedactedSecretValue(V);
    expect(knownSecretValues()).toContain(V);
  });
});

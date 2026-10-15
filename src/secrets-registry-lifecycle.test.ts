// The vault is the user's declaration of what is a secret, and the known-value
// registry follows it: a value is registered when saved, the old value is
// withdrawn when a secret is replaced, and the value is withdrawn when the
// secret is deleted — unless another vault entry still holds it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SecretsStore } from "./secrets.js";
import { knownSecretValues } from "./security/secrets/index.js";

const OLD = "Old-Rotated-Value-7Qz2";
const NEW = "New-Current-Value-4Lm9";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-secrets-registry-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the known-value registry follows the vault", () => {
  it("withdraws a replaced value and a deleted one", () => {
    const store = new SecretsStore(dir);
    store.set("API_KEY", OLD);
    expect(knownSecretValues()).toContain(OLD);
    store.set("API_KEY", NEW);
    expect(knownSecretValues()).not.toContain(OLD);
    expect(knownSecretValues()).toContain(NEW);
    store.delete("API_KEY");
    expect(knownSecretValues()).not.toContain(NEW);
  });

  it("keeps a value another entry still holds", () => {
    const store = new SecretsStore(dir);
    store.set("PRIMARY", NEW);
    store.set("BACKUP", NEW);
    store.delete("PRIMARY");
    expect(knownSecretValues()).toContain(NEW);
    store.delete("BACKUP");
    expect(knownSecretValues()).not.toContain(NEW);
  });

  it("registers what it loads, under each entry's own name", () => {
    new SecretsStore(dir).set("LOADED", OLD);
    new SecretsStore(dir).delete("LOADED");
    expect(knownSecretValues()).not.toContain(OLD);
  });
});

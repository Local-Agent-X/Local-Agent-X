/**
 * SecretsStore quarantine behavior — locks in the post-2026-05-09 fix.
 *
 * Before the fix, `secrets.ts:load()` wrapped its `for entry of raw.secrets`
 * loop in a single try/catch. The first entry whose `decrypt()` threw
 * (e.g. encrypted with a now-rotated master key) aborted the entire loop;
 * every subsequent entry never landed in the in-memory Map. The next
 * `set()` then called `save()`, which serialized only the in-memory
 * survivors back to disk — silently overwriting the ciphertext bytes of
 * every dropped entry, even though those bytes might still have been
 * recoverable with the correct key (e.g. restore from backup).
 *
 * The fix:
 *   1. Per-entry try/catch — one bad row no longer kills its successors.
 *   2. `quarantined: SecretsFileEntry[]` — undecryptable rows kept verbatim.
 *   3. `save()` re-encrypts live entries with the current key, then appends
 *      every quarantined row unchanged so the ciphertext stays on disk.
 *   4. Live `set()` for a name that's currently quarantined drops the
 *      quarantine duplicate (live wins; user re-added the secret).
 *   5. `delete(name)` removes a quarantined entry too — explicit "give up"
 *      signal from the user.
 *
 * These tests exercise each of those guarantees against a real on-disk
 * secrets.enc the test owns. No keychain mocking — we use the actual
 * SecretsStore against a per-test temp dataDir and inject a corrupted
 * ciphertext directly into the file so the failure mode is realistic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SecretsStore } from "../src/secrets.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lax-secrets-test-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface RawSecretsFile {
  version: 1;
  secrets: Array<{
    name: string;
    addedAt: number;
    updatedAt: number;
    encrypted: string;
  }>;
}

function readSecretsFile(): RawSecretsFile {
  return JSON.parse(readFileSync(join(tmpDir, "secrets.enc"), "utf-8")) as RawSecretsFile;
}

describe("SecretsStore quarantine", () => {
  it("one corrupt entry no longer hides every entry that comes after it", () => {
    // Seed a real store with three secrets so their ciphertext is valid.
    const seed = new SecretsStore(tmpDir);
    seed.set("FIRST", "value-1");
    seed.set("SECOND", "value-2");
    seed.set("THIRD", "value-3");

    // Corrupt SECOND's ciphertext on disk. The 28-byte prefix (iv 12 +
    // authTag 16) is fine; flip the first ciphertext byte (hex char 56
    // and 57 in the encoded string) so AES-GCM auth-tag verification
    // fails on decrypt.
    const raw = readSecretsFile();
    const second = raw.secrets.find(s => s.name === "SECOND")!;
    const hex = second.encrypted;
    // hex char index 56 is the first byte of ciphertext past iv+tag.
    const flipped = hex.slice(0, 56) + (hex[56] === "0" ? "f" : "0") + hex.slice(57);
    second.encrypted = flipped;
    writeFileSync(join(tmpDir, "secrets.enc"), JSON.stringify(raw, null, 2));

    // Reload — SECOND must quarantine; FIRST and THIRD must still be
    // present and decrypt to their original values.
    const store = new SecretsStore(tmpDir);
    expect(store.get("FIRST")).toBe("value-1");
    expect(store.get("THIRD")).toBe("value-3");
    expect(store.get("SECOND")).toBeUndefined();
    expect(store.quarantinedCount()).toBe(1);
    expect(store.quarantinedNames()).toEqual(["SECOND"]);
  });

  it("save() preserves quarantined ciphertext verbatim", () => {
    // Same setup as above.
    const seed = new SecretsStore(tmpDir);
    seed.set("ALPHA", "v-a");
    seed.set("BETA", "v-b");
    const raw = readSecretsFile();
    const betaOriginalCipher = raw.secrets.find(s => s.name === "BETA")!.encrypted;
    const beta = raw.secrets.find(s => s.name === "BETA")!;
    beta.encrypted = beta.encrypted.slice(0, 56) + "ff" + beta.encrypted.slice(58);
    const betaCorruptCipher = beta.encrypted;
    writeFileSync(join(tmpDir, "secrets.enc"), JSON.stringify(raw, null, 2));

    // Reload with BETA quarantined.
    const store = new SecretsStore(tmpDir);
    expect(store.quarantinedCount()).toBe(1);

    // Add a brand new live entry — triggers save(). BETA's corrupted
    // ciphertext must round-trip unchanged so a future boot with the
    // correct key can still attempt recovery.
    store.set("GAMMA", "v-g");
    const afterSave = readSecretsFile();
    const betaAfter = afterSave.secrets.find(s => s.name === "BETA");
    expect(betaAfter, "BETA must remain on disk").toBeDefined();
    expect(betaAfter!.encrypted).toBe(betaCorruptCipher);
    // ALPHA stayed live and got re-encrypted with the current key —
    // its ciphertext WILL change between writes (fresh IV every time),
    // but it must still decrypt to the original value.
    expect(store.get("ALPHA")).toBe("v-a");
    expect(store.get("GAMMA")).toBe("v-g");
    // Pin the assertion that quarantined cipher !== original cipher so
    // a future regression that re-encrypts quarantined entries with the
    // wrong key would surface here.
    expect(betaCorruptCipher).not.toBe(betaOriginalCipher);
  });

  it("set() with a quarantined name drops the quarantine duplicate", () => {
    const seed = new SecretsStore(tmpDir);
    seed.set("REUSED", "old-value");
    const raw = readSecretsFile();
    const e = raw.secrets[0];
    e.encrypted = e.encrypted.slice(0, 56) + "ff" + e.encrypted.slice(58);
    writeFileSync(join(tmpDir, "secrets.enc"), JSON.stringify(raw, null, 2));

    const store = new SecretsStore(tmpDir);
    expect(store.quarantinedCount()).toBe(1);

    // User re-adds the same secret name via the UI. The quarantine
    // entry must drop so it doesn't shadow the live one on the next
    // load.
    store.set("REUSED", "new-value");
    expect(store.quarantinedCount()).toBe(0);
    expect(store.get("REUSED")).toBe("new-value");

    // Cold-boot the store to confirm the on-disk state matches.
    const reloaded = new SecretsStore(tmpDir);
    expect(reloaded.get("REUSED")).toBe("new-value");
    expect(reloaded.quarantinedCount()).toBe(0);
  });

  it("delete() removes quarantined entries — explicit user give-up", () => {
    const seed = new SecretsStore(tmpDir);
    seed.set("DEAD", "no-one-can-read-me");
    const raw = readSecretsFile();
    const e = raw.secrets[0];
    e.encrypted = e.encrypted.slice(0, 56) + "ff" + e.encrypted.slice(58);
    writeFileSync(join(tmpDir, "secrets.enc"), JSON.stringify(raw, null, 2));

    const store = new SecretsStore(tmpDir);
    expect(store.quarantinedCount()).toBe(1);

    const deleted = store.delete("DEAD");
    expect(deleted).toBe(true);
    expect(store.quarantinedCount()).toBe(0);

    const reloaded = new SecretsStore(tmpDir);
    expect(reloaded.quarantinedCount()).toBe(0);
    // DEAD is fully gone from disk too.
    const final = readSecretsFile();
    expect(final.secrets.find(s => s.name === "DEAD")).toBeUndefined();
  });

  it("list() excludes quarantined entries; listQuarantined() returns them", () => {
    const seed = new SecretsStore(tmpDir);
    seed.set("LIVE", "v");
    seed.set("DEAD", "v");
    const raw = readSecretsFile();
    const dead = raw.secrets.find(s => s.name === "DEAD")!;
    dead.encrypted = dead.encrypted.slice(0, 56) + "ff" + dead.encrypted.slice(58);
    writeFileSync(join(tmpDir, "secrets.enc"), JSON.stringify(raw, null, 2));

    const store = new SecretsStore(tmpDir);
    const live = store.list().map(e => e.name);
    const quar = store.listQuarantined().map(e => e.name);
    expect(live).toEqual(["LIVE"]);
    expect(quar).toEqual(["DEAD"]);
  });
});

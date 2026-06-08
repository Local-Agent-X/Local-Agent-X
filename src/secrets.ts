import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getOrCreateMasterKey, type KeychainProvider } from "./keychain.js";
import { registerRedactedSecretValue } from "./security/known-secrets.js";

import { createLogger } from "./logger.js";
const logger = createLogger("secrets");

/**
 * Encrypted secrets store for API keys and tokens.
 * Secrets are AES-256-GCM encrypted at rest in ~/.lax/secrets.enc
 *
 * Master key is stored in the OS keychain (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux) rather than derived from machine identity. This means
 * even with full filesystem access, an attacker can't decrypt without the
 * user's OS login credentials.
 *
 * Fallback chain:
 * 1. Windows DPAPI (tied to Windows login)
 * 2. macOS Keychain (tied to macOS login)
 * 3. Linux libsecret (tied to desktop session)
 * 4. Machine-identity derivation (hostname+username+random salt) — last resort
 */

interface SecretEntry {
  name: string;
  value: string;       // encrypted at rest, decrypted in memory
  service?: string;    // e.g. "github", "slack", "linear"
  account?: string;    // username/email paired with this password
  url?: string;        // login page URL
  notes?: string;      // free-form user-visible notes
  origin?: string;     // origin derived from url (scheme://host[:port]); authoritative for fill gating
  createdBySession?: string; // agent session that captured this secret; enables auto-approval of same-session reuse
  approvedFills?: Array<{ origin: string; approvedAt: number }>; // user-approved (secret, origin) pairs for automated fill
  addedAt: number;
  updatedAt: number;
}

export interface SecretMetadata {
  service?: string;
  account?: string;
  url?: string;
  notes?: string;
  origin?: string;
  createdBySession?: string;
}

/** Metadata view returned to callers — never includes the plaintext value. */
export interface SecretMetaView {
  name: string;
  service?: string;
  account?: string;
  url?: string;
  notes?: string;
  origin?: string;
  createdBySession?: string;
  approvedFills?: Array<{ origin: string; approvedAt: number }>;
  addedAt: number;
  updatedAt: number;
}

interface SecretsFileEntry {
  name: string;
  service?: string;
  account?: string;
  url?: string;
  notes?: string;
  origin?: string;
  createdBySession?: string;
  approvedFills?: Array<{ origin: string; approvedAt: number }>;
  addedAt: number;
  updatedAt: number;
  encrypted: string; // hex: iv(12) + authTag(16) + ciphertext
}

interface SecretsFile {
  version: 1;
  secrets: SecretsFileEntry[];
}

/** Derive a canonical origin (scheme://host[:port]) from an arbitrary URL. Returns undefined on failure. */
export function deriveOrigin(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("hex");
}

function decrypt(hex: string, key: Buffer): string {
  const data = Buffer.from(hex, "hex");
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const result = decipher.update(ciphertext) + decipher.final("utf-8");
  // Zero the raw buffer to limit exposure of ciphertext material in memory
  data.fill(0);
  return result;
}

export class SecretsStore {
  private filePath: string;
  private key: Buffer;
  private secrets: Map<string, SecretEntry> = new Map();
  /**
   * Entries that failed to decrypt at load time. Held verbatim so save()
   * can write them BACK unchanged — preserving the ciphertext on disk in
   * case the user later restores the right master key (e.g. recovers
   * master.dpapi from backup) and reboots the server.
   *
   * Without this, any save() (triggered by `set` / `delete` / `approveFill`
   * / `revokeFillApproval`) would silently overwrite undecryptable
   * entries with only the survivors — which is exactly the wipe pattern
   * that lost a user's API keys after the 2026-05-09 master-key rotation
   * incident documented in keychain.ts:217-228.
   */
  private quarantined: SecretsFileEntry[] = [];
  public readonly keychainProvider: KeychainProvider;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "secrets.enc");
    const { key, provider } = getOrCreateMasterKey(dataDir);
    this.key = key;
    this.keychainProvider = provider;
    logger.info(`[secrets] Encryption key from: ${provider}`);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;

    let raw: SecretsFile;
    try {
      raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as SecretsFile;
    } catch (e) {
      // File-level corruption — JSON parse fail. Distinct from per-entry
      // decrypt failure; nothing we can quarantine because we can't even
      // see the entries. Log loud and bail; save() won't be called until
      // a successful `set()`, which would still nuke the unparseable
      // file. That's a known tradeoff — if JSON is unparseable, the file
      // is effectively dead anyway.
      logger.error(`[secrets] CRITICAL: Failed to parse ${this.filePath}: ${(e as Error).message}. Existing secrets are unreadable. Restore from backup before adding new secrets or they will overwrite the file.`);
      return;
    }

    let okCount = 0;
    let failCount = 0;
    for (const entry of raw.secrets) {
      try {
        const value = decrypt(entry.encrypted, this.key);
        // Proactively register the plaintext with the known-secret-value
        // registry so the egress scanner / taint path / redactor can match the
        // user's ACTUAL secrets the moment the store loads — without waiting for
        // the value to first be used in a browser fill / clipboard write.
        // isSecretShaped gates inside register(), so short/numeric values
        // (ports, PINs) are skipped (no false-positive egress blocks).
        registerRedactedSecretValue(value);
        this.secrets.set(entry.name, {
          name: entry.name,
          value,
          service: entry.service,
          account: entry.account,
          url: entry.url,
          notes: entry.notes,
          origin: entry.origin ?? deriveOrigin(entry.url),
          createdBySession: entry.createdBySession,
          approvedFills: entry.approvedFills,
          addedAt: entry.addedAt,
          updatedAt: entry.updatedAt,
        });
        okCount++;
      } catch (e) {
        // Per-entry decrypt failure. Keep the ciphertext alive in
        // `quarantined` so the next save() writes it back unchanged. A
        // future boot with the correct master key (restored from
        // backup, OS keychain restored, etc.) will decrypt it
        // successfully and lift the quarantine.
        this.quarantined.push(entry);
        failCount++;
        logger.warn(`[secrets] decrypt failed for "${entry.name}" (added ${new Date(entry.addedAt).toISOString()}): ${(e as Error).message} — quarantined, ciphertext preserved on disk`);
      }
    }

    if (failCount > 0) {
      logger.error(
        `[secrets] CRITICAL: ${failCount} of ${raw.secrets.length} secrets failed to decrypt. ` +
        `Master key likely rotated since these entries were encrypted (see keychain.ts:217-228 for the May 2026 incident).\n` +
        `${this.quarantined.map(e => `  - ${e.name} (added ${new Date(e.addedAt).toISOString()})`).join("\n")}\n` +
        `Their ciphertext is preserved on disk and will be written back verbatim on the next save. ` +
        `If you have a backup of the matching master.dpapi / OS keychain entry, restore it and reboot. ` +
        `Otherwise the values are unrecoverable — re-add the secrets via the UI; the dead entries will be replaced.`,
      );
    } else {
      logger.info(`[secrets] Loaded ${okCount} secret${okCount === 1 ? "" : "s"}`);
    }
  }

  private save(): void {
    // Re-encrypt every live secret with the current master key.
    const reencrypted: SecretsFileEntry[] = Array.from(this.secrets.values()).map((s) => ({
      name: s.name,
      service: s.service,
      account: s.account,
      url: s.url,
      notes: s.notes,
      origin: s.origin,
      createdBySession: s.createdBySession,
      approvedFills: s.approvedFills,
      addedAt: s.addedAt,
      updatedAt: s.updatedAt,
      encrypted: encrypt(s.value, this.key),
    }));
    // Pass quarantined entries through unchanged. If a live entry shares
    // a name with a quarantined one — e.g. user re-added a secret after
    // losing the old key — the live entry wins; drop the quarantined
    // duplicate so it doesn't shadow on the next load.
    const liveNames = new Set(reencrypted.map(e => e.name));
    const survivingQuarantine = this.quarantined.filter(q => !liveNames.has(q.name));
    if (survivingQuarantine.length !== this.quarantined.length) {
      this.quarantined = survivingQuarantine;
    }
    const data: SecretsFile = {
      version: 1,
      secrets: [...reencrypted, ...survivingQuarantine],
    };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  }

  /** Number of entries that failed to decrypt at load time and are being
   *  preserved on disk for possible future recovery. Surfaced for status
   *  UIs / health checks that want to warn the user "your secrets need
   *  attention" instead of silently looking fine. */
  quarantinedCount(): number {
    return this.quarantined.length;
  }

  /** Names of the quarantined entries — values stay encrypted, never
   *  exposed. Useful for surfacing "these specific secrets need to be
   *  re-added" in the UI. */
  quarantinedNames(): string[] {
    return this.quarantined.map(e => e.name);
  }

  /** Get a decrypted secret value by name. Returns undefined if not found. */
  get(name: string): string | undefined {
    return this.secrets.get(name)?.value;
  }

  /** Set or update a secret. Pass a SecretMetadata object (preferred) or a
   *  raw `service` string for backward compatibility with older callers. */
  set(name: string, value: string, meta?: SecretMetadata | string): void {
    const existing = this.secrets.get(name);
    const metaObj: SecretMetadata = typeof meta === "string" ? { service: meta } : (meta || {});
    const url = metaObj.url ?? existing?.url;
    // Register the new/updated value so it's immediately matchable by the egress
    // scanner (gated by isSecretShaped inside register()).
    registerRedactedSecretValue(value);
    this.secrets.set(name, {
      name,
      value,
      service: metaObj.service ?? existing?.service,
      account: metaObj.account ?? existing?.account,
      url,
      notes: metaObj.notes ?? existing?.notes,
      origin: metaObj.origin ?? existing?.origin ?? deriveOrigin(url),
      createdBySession: metaObj.createdBySession ?? existing?.createdBySession,
      approvedFills: existing?.approvedFills,
      addedAt: existing?.addedAt || Date.now(),
      updatedAt: Date.now(),
    });
    this.save();
  }

  /** Delete a secret by name. Returns true if it existed (live OR quarantined).
   *  Deleting a quarantined name is the user's explicit signal that the lost
   *  value is unrecoverable and they want the dead entry gone for good. */
  delete(name: string): boolean {
    const liveExisted = this.secrets.delete(name);
    const quarantineBefore = this.quarantined.length;
    this.quarantined = this.quarantined.filter(q => q.name !== name);
    const quarantineRemoved = this.quarantined.length < quarantineBefore;
    const existed = liveExisted || quarantineRemoved;
    if (existed) this.save();
    return existed;
  }

  /** Check if a secret exists. */
  has(name: string): boolean {
    return this.secrets.has(name);
  }

  /** List all USABLE secret names and metadata (never exposes values).
   *  Quarantined entries (failed to decrypt at load) are excluded — the
   *  agent can't use them, so they shouldn't appear in agent-facing
   *  surfaces. UIs that want to surface "you have dead entries to clean
   *  up" should call `listQuarantined()` separately. */
  list(): SecretMetaView[] {
    return Array.from(this.secrets.values()).map(({ name, service, account, url, notes, origin, createdBySession, approvedFills, addedAt, updatedAt }) => ({
      name,
      service,
      account,
      url,
      notes,
      origin,
      createdBySession,
      approvedFills,
      addedAt,
      updatedAt,
    }));
  }

  /** List metadata for entries that failed to decrypt at load. The
   *  ciphertext is preserved on disk through save(), so a future boot
   *  with the right master key may rehabilitate them. The UI should
   *  show these in a distinct "needs attention" section so the user
   *  knows which secrets to re-add or recover. */
  listQuarantined(): SecretMetaView[] {
    return this.quarantined.map(({ name, service, account, url, notes, origin, createdBySession, approvedFills, addedAt, updatedAt }) => ({
      name, service, account, url, notes, origin,
      createdBySession, approvedFills, addedAt, updatedAt,
    }));
  }

  /** Read metadata for a single secret (never exposes the value). */
  getMeta(name: string): SecretMetaView | undefined {
    const e = this.secrets.get(name);
    if (!e) return undefined;
    return {
      name: e.name,
      service: e.service,
      account: e.account,
      url: e.url,
      notes: e.notes,
      origin: e.origin,
      createdBySession: e.createdBySession,
      approvedFills: e.approvedFills,
      addedAt: e.addedAt,
      updatedAt: e.updatedAt,
    };
  }

  /** Record that the user has approved filling a given secret on a given origin.
   *  No-op if already approved; persists on first approval. */
  approveFill(name: string, origin: string): boolean {
    const entry = this.secrets.get(name);
    if (!entry) return false;
    const normalized = deriveOrigin(origin) ?? origin;
    if (!entry.approvedFills) entry.approvedFills = [];
    if (entry.approvedFills.some((a) => a.origin === normalized)) return true;
    entry.approvedFills.push({ origin: normalized, approvedAt: Date.now() });
    entry.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** Remove an origin from a secret's approved-fills list. */
  revokeFillApproval(name: string, origin: string): boolean {
    const entry = this.secrets.get(name);
    if (!entry || !entry.approvedFills) return false;
    const normalized = deriveOrigin(origin) ?? origin;
    const before = entry.approvedFills.length;
    entry.approvedFills = entry.approvedFills.filter((a) => a.origin !== normalized);
    if (entry.approvedFills.length === before) return false;
    entry.updatedAt = Date.now();
    this.save();
    return true;
  }

  /** Check whether a secret has been user-approved for fill at a given origin. */
  isFillApproved(name: string, origin: string): boolean {
    const entry = this.secrets.get(name);
    if (!entry || !entry.approvedFills) return false;
    const normalized = deriveOrigin(origin) ?? origin;
    return entry.approvedFills.some((a) => a.origin === normalized);
  }

  /** Resolve {{SECRET_NAME}} placeholders in a string. Returns the resolved string. */
  resolve(input: string): string {
    return input.replace(/\{\{(\w+)\}\}/g, (_match, name) => {
      return this.get(name) || `{{${name}}}`;
    });
  }

  /** Get names of all {{SECRET_NAME}} placeholders that are missing from the store. */
  findMissing(input: string): string[] {
    const missing: string[] = [];
    const pattern = /\{\{(\w+)\}\}/g;
    let match;
    while ((match = pattern.exec(input)) !== null) {
      if (!this.has(match[1])) {
        missing.push(match[1]);
      }
    }
    return missing;
  }

  /** Zero the master key and clear all decrypted values from memory. */
  destroy(): void {
    this.key.fill(0);
    this.secrets.clear();
  }
}

// Module-level singleton so modules that aren't built as factories (e.g.
// email-tools.ts) can read from the encrypted vault without needing to be
// re-wired. Same pattern as getRuntimeConfig() in config.ts.
let _secretsStoreSingleton: SecretsStore | null = null;
export function setSecretsStoreSingleton(store: SecretsStore): void {
  _secretsStoreSingleton = store;
}
export function getSecretsStoreSingleton(): SecretsStore | null {
  return _secretsStoreSingleton;
}

// Returns the process-wide SecretsStore, constructing it (and registering it
// as the singleton) on first call. Use this instead of `new SecretsStore(dir)`
// in code paths that may run before the server has booted the singleton —
// self-edit, primal-auto-build judges, and any other subprocess entrypoint.
// Constructing a fresh SecretsStore each time hits the OS keychain on every
// call, which is what surfaced the "Keychain Not Found" GUI dialog cascade.
export function getOrInitSecretsStore(dataDir: string): SecretsStore {
  let store = _secretsStoreSingleton;
  if (!store) {
    store = new SecretsStore(dataDir);
    _secretsStoreSingleton = store;
  }
  return store;
}

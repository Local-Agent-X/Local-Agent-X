import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getOrCreateMasterKey, type KeychainProvider } from "./keychain.js";

/**
 * Encrypted secrets store for API keys and tokens.
 * Secrets are AES-256-GCM encrypted at rest in ~/.sax/secrets.enc
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
  addedAt: number;
  updatedAt: number;
}

export interface SecretMetadata {
  service?: string;
  account?: string;
  url?: string;
  notes?: string;
}

interface SecretsFile {
  version: 1;
  secrets: Array<{
    name: string;
    service?: string;
    account?: string;
    url?: string;
    notes?: string;
    addedAt: number;
    updatedAt: number;
    encrypted: string; // hex: iv(12) + authTag(16) + ciphertext
  }>;
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
  public readonly keychainProvider: KeychainProvider;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "secrets.enc");
    const { key, provider } = getOrCreateMasterKey(dataDir);
    this.key = key;
    this.keychainProvider = provider;
    console.log(`[secrets] Encryption key from: ${provider}`);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;

    try {
      const raw: SecretsFile = JSON.parse(readFileSync(this.filePath, "utf-8"));
      for (const entry of raw.secrets) {
        this.secrets.set(entry.name, {
          name: entry.name,
          value: decrypt(entry.encrypted, this.key),
          service: entry.service,
          account: entry.account,
          url: entry.url,
          notes: entry.notes,
          addedAt: entry.addedAt,
          updatedAt: entry.updatedAt,
        });
      }
    } catch (e) {
      console.warn(`[secrets] Failed to load secrets: ${(e as Error).message}`);
    }
  }

  private save(): void {
    const data: SecretsFile = {
      version: 1,
      secrets: Array.from(this.secrets.values()).map((s) => ({
        name: s.name,
        service: s.service,
        account: s.account,
        url: s.url,
        notes: s.notes,
        addedAt: s.addedAt,
        updatedAt: s.updatedAt,
        encrypted: encrypt(s.value, this.key),
      })),
    };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
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
    this.secrets.set(name, {
      name,
      value,
      service: metaObj.service ?? existing?.service,
      account: metaObj.account ?? existing?.account,
      url: metaObj.url ?? existing?.url,
      notes: metaObj.notes ?? existing?.notes,
      addedAt: existing?.addedAt || Date.now(),
      updatedAt: Date.now(),
    });
    this.save();
  }

  /** Delete a secret by name. Returns true if it existed. */
  delete(name: string): boolean {
    const existed = this.secrets.delete(name);
    if (existed) this.save();
    return existed;
  }

  /** Check if a secret exists. */
  has(name: string): boolean {
    return this.secrets.has(name);
  }

  /** List all secret names and metadata (never exposes values). */
  list(): Array<{ name: string; service?: string; account?: string; url?: string; notes?: string; addedAt: number; updatedAt: number }> {
    return Array.from(this.secrets.values()).map(({ name, service, account, url, notes, addedAt, updatedAt }) => ({
      name,
      service,
      account,
      url,
      notes,
      addedAt,
      updatedAt,
    }));
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

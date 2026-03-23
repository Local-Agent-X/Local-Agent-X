import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { hostname, userInfo } from "node:os";

/**
 * Encrypted secrets store for API keys and tokens.
 * Secrets are AES-256-GCM encrypted at rest in ~/.sax/secrets.enc
 * Key is derived from machine identity (hostname + username).
 */

interface SecretEntry {
  name: string;
  value: string;       // encrypted at rest, decrypted in memory
  service?: string;    // e.g. "github", "slack", "linear"
  addedAt: number;
  updatedAt: number;
}

interface SecretsFile {
  version: 1;
  secrets: Array<{
    name: string;
    service?: string;
    addedAt: number;
    updatedAt: number;
    encrypted: string; // hex: iv(24) + authTag(32) + ciphertext
  }>;
}

function deriveKey(): Buffer {
  // Machine-bound key: not perfect security, but keeps secrets from being
  // plain text on disk. For stronger security, use OS keychain in the future.
  const identity = `sax-secrets::${hostname()}::${userInfo().username}`;
  return scryptSync(identity, "secret-agent-x-salt-v1", 32);
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
  return decipher.update(ciphertext) + decipher.final("utf-8");
}

export class SecretsStore {
  private filePath: string;
  private key: Buffer;
  private secrets: Map<string, SecretEntry> = new Map();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, "secrets.enc");
    this.key = deriveKey();
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
        addedAt: s.addedAt,
        updatedAt: s.updatedAt,
        encrypted: encrypt(s.value, this.key),
      })),
    };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /** Get a decrypted secret value by name. Returns undefined if not found. */
  get(name: string): string | undefined {
    return this.secrets.get(name)?.value;
  }

  /** Set or update a secret. */
  set(name: string, value: string, service?: string): void {
    const existing = this.secrets.get(name);
    this.secrets.set(name, {
      name,
      value,
      service: service || existing?.service,
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
  list(): Array<{ name: string; service?: string; addedAt: number; updatedAt: number }> {
    return Array.from(this.secrets.values()).map(({ name, service, addedAt, updatedAt }) => ({
      name,
      service,
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
}

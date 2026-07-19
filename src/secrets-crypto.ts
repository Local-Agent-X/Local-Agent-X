import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretEntry, SecretsFile, SecretsFileEntry } from "./secrets-types.js";

export const MASTER_KEY_DEPENDENT_BASENAMES = [
  "secrets.enc",
  "audit-key.enc",
  "auth.json",
  "anthropic-auth.json",
  "xai-auth.json",
] as const;

function isEncryptedMasterKeyDependent(path: string): boolean {
  if (!existsSync(path)) return false;
  if (path.endsWith("secrets.enc") || path.endsWith("audit-key.enc")) return true;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const format = (parsed as Record<string, unknown>).format;
    return typeof format === "string" && format.startsWith("lax-auth-v");
  } catch {
    return true;
  }
}

export function assertKeyRecoverySafe(dataDir: string, provider: string, why: string): void {
  const dependents = MASTER_KEY_DEPENDENT_BASENAMES
    .map((name) => join(dataDir, name))
    .filter((path) => isEncryptedMasterKeyDependent(path));
  if (dependents.length === 0) return;
  throw new Error(
    `Cannot retrieve ${provider}-protected master key — ${why}\n` +
    `Refusing to auto-regenerate; that would invalidate encrypted data: ${dependents.join(", ")}.\n` +
    "Restore keychain access or intentionally remove every listed dependent before creating a new key.",
  );
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

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("hex");
}

export function decrypt(hex: string, key: Buffer): string {
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

export function encryptSecretsFile(
  secrets: ReadonlyMap<string, SecretEntry>,
  quarantined: readonly SecretsFileEntry[],
  key: Buffer,
): SecretsFile {
  const live = Array.from(secrets.values()).map((secret) => ({
    name: secret.name,
    service: secret.service,
    account: secret.account,
    url: secret.url,
    notes: secret.notes,
    origin: secret.origin,
    createdBySession: secret.createdBySession,
    approvedFills: secret.approvedFills,
    addedAt: secret.addedAt,
    updatedAt: secret.updatedAt,
    encrypted: encrypt(secret.value, key),
  }));
  const liveNames = new Set(live.map((entry) => entry.name));
  return { version: 1, secrets: [...live, ...quarantined.filter((entry) => !liveNames.has(entry.name))] };
}

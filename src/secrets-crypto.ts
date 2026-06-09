import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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

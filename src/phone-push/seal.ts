// Seals an alert so only the phone that made the key can read it (the format
// is agentxos push.ts: AES-256-GCM, a fresh 12-byte nonce, PUSH_AAD, the tag
// appended to the ciphertext).

import { createCipheriv, randomBytes } from "node:crypto";
import { PUSH_AAD, PUSH_NONCE_BYTES, type PushAlert, type SealedPushData } from "../broker-transport/vendor/protocol.js";

export function sealPushAlert(alert: PushAlert, keyBase64: string): SealedPushData {
  const nonce = randomBytes(PUSH_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), nonce);
  cipher.setAAD(Buffer.from(PUSH_AAD, "utf8"));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(alert), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, n: nonce.toString("base64"), c: sealed.toString("base64") };
}

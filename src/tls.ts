import { generateKeyPairSync, createSign, createHash, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * TLS Certificate Management — Pure Node.js (no OpenSSL needed)
 *
 * Generates a self-signed certificate for HTTPS localhost using only
 * Node's built-in crypto module. Works on every machine, zero dependencies.
 *
 * Cert stored in ~/.sax/tls/cert.pem + key.pem
 * Valid for 825 days, auto-regenerates on expiry.
 */

export interface TLSCert {
  cert: string;
  key: string;
}

// ASN.1 DER encoding helpers
function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function derSeq(items: Buffer[]): Buffer {
  const body = Buffer.concat(items);
  return Buffer.concat([Buffer.from([0x30]), derLen(body.length), body]);
}

function derSet(items: Buffer[]): Buffer {
  const body = Buffer.concat(items);
  return Buffer.concat([Buffer.from([0x31]), derLen(body.length), body]);
}

function derOid(oid: number[]): Buffer {
  const bytes: number[] = [];
  bytes.push(oid[0] * 40 + oid[1]);
  for (let i = 2; i < oid.length; i++) {
    let v = oid[i];
    if (v >= 128) {
      const enc: number[] = [];
      enc.push(v & 0x7f); v >>= 7;
      while (v > 0) { enc.push(0x80 | (v & 0x7f)); v >>= 7; }
      bytes.push(...enc.reverse());
    } else {
      bytes.push(v);
    }
  }
  const buf = Buffer.from(bytes);
  return Buffer.concat([Buffer.from([0x06]), derLen(buf.length), buf]);
}

function derUtf8(str: string): Buffer {
  const buf = Buffer.from(str, "utf-8");
  return Buffer.concat([Buffer.from([0x0c]), derLen(buf.length), buf]);
}

function derInt(n: number | Buffer): Buffer {
  let buf: Buffer;
  if (typeof n === "number") {
    if (n === 0) buf = Buffer.from([0]);
    else {
      const hex = n.toString(16);
      buf = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
      if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
    }
  } else {
    buf = n;
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  }
  return Buffer.concat([Buffer.from([0x02]), derLen(buf.length), buf]);
}

function derBitStr(buf: Buffer): Buffer {
  const wrapped = Buffer.concat([Buffer.from([0]), buf]);
  return Buffer.concat([Buffer.from([0x03]), derLen(wrapped.length), wrapped]);
}

function derOctetStr(buf: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x04]), derLen(buf.length), buf]);
}

function derExplicit(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xa0 | tag]), derLen(content.length), content]);
}

function derGeneralizedTime(date: Date): Buffer {
  const s = date.toISOString().replace(/[-:T]/g, "").replace(/\.\d+Z/, "Z");
  const buf = Buffer.from(s, "ascii");
  return Buffer.concat([Buffer.from([0x18]), derLen(buf.length), buf]);
}

// OIDs
const OID_CN = [2, 5, 4, 3];
const OID_O = [2, 5, 4, 10];
const OID_SHA256_RSA = [1, 2, 840, 113549, 1, 1, 11];
const OID_RSA = [1, 2, 840, 113549, 1, 1, 1];
const OID_SAN = [2, 5, 29, 17];
const OID_BASIC_CONSTRAINTS = [2, 5, 29, 19];

function buildRDN(oid: number[], value: string): Buffer {
  return derSet([derSeq([derOid(oid), derUtf8(value)])]);
}

function buildSAN(): Buffer {
  // DNS:localhost, IP:127.0.0.1, IP:::1
  const dns = Buffer.concat([Buffer.from([0x82]), derLen(9), Buffer.from("localhost")]);
  const ip4 = Buffer.concat([Buffer.from([0x87]), derLen(4), Buffer.from([127, 0, 0, 1])]);
  const ip6 = Buffer.concat([Buffer.from([0x87]), derLen(16), Buffer.from("00000000000000000000000000000001", "hex")]);
  const sanValue = derSeq([dns, ip4, ip6]);
  return derSeq([derOid(OID_SAN), Buffer.from([0x01, 0x01, 0xff]), derOctetStr(sanValue)]);
}

function buildBasicConstraints(): Buffer {
  const value = derSeq([Buffer.from([0x01, 0x01, 0xff])]); // CA:TRUE
  return derSeq([derOid(OID_BASIC_CONSTRAINTS), Buffer.from([0x01, 0x01, 0xff]), derOctetStr(value)]);
}

/**
 * Generate a self-signed certificate using pure Node.js crypto.
 */
function generateSelfSignedCert(): TLSCert {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const now = new Date();
  const expiry = new Date(now.getTime() + 825 * 24 * 60 * 60 * 1000);
  const serial = createHash("sha256").update(String(Date.now())).digest().subarray(0, 8);

  const issuer = derSeq([buildRDN(OID_CN, "localhost"), buildRDN(OID_O, "SecretAgentX")]);
  const subject = issuer; // Self-signed: issuer = subject

  const extensions = derSeq([buildSAN(), buildBasicConstraints()]);

  // TBS (To Be Signed) Certificate
  const tbs = derSeq([
    derExplicit(0, derInt(2)), // Version 3
    derInt(serial),
    derSeq([derOid(OID_SHA256_RSA), Buffer.from([0x05, 0x00])]), // SHA256withRSA
    issuer,
    derSeq([derGeneralizedTime(now), derGeneralizedTime(expiry)]),
    subject,
    derSeq([derSeq([derOid(OID_RSA), Buffer.from([0x05, 0x00])]), derBitStr(publicKey as unknown as Buffer)]),
    derExplicit(3, extensions),
  ]);

  // Sign the TBS
  const signer = createSign("SHA256");
  signer.update(tbs);
  const signature = signer.sign(privateKey);

  // Build full certificate
  const cert = derSeq([
    tbs,
    derSeq([derOid(OID_SHA256_RSA), Buffer.from([0x05, 0x00])]),
    derBitStr(signature),
  ]);

  const certPem = `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;

  return { cert: certPem, key: privateKey as unknown as string };
}

/**
 * Get or create TLS certificate for localhost.
 */
export function getOrCreateCert(dataDir: string): TLSCert | null {
  const tlsDir = join(dataDir, "tls");
  const certPath = join(tlsDir, "cert.pem");
  const keyPath = join(tlsDir, "key.pem");

  // Check existing certs
  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      const cert = readFileSync(certPath, "utf-8");
      const key = readFileSync(keyPath, "utf-8");
      // Validate with Node's X509Certificate
      const x509 = new X509Certificate(cert);
      const notAfter = new Date(x509.validTo);
      if (notAfter > new Date(Date.now() + 86400_000)) { // Valid for at least 1 more day
        return { cert, key };
      }
      console.log("[tls] Certificate expired, regenerating...");
    } catch {}
  }

  // Generate new cert
  console.log("[tls] Generating self-signed certificate for localhost (pure Node.js)...");
  mkdirSync(tlsDir, { recursive: true });

  try {
    const { cert, key } = generateSelfSignedCert();
    writeFileSync(certPath, cert, { mode: 0o600 });
    writeFileSync(keyPath, key, { mode: 0o600 });
    console.log("[tls] Certificate generated successfully");

    // Auto-trust on Windows
    if (process.platform === "win32") {
      try {
        const { execFileSync } = require("child_process");
        execFileSync("certutil", ["-user", "-addstore", "Root", certPath], {
          timeout: 10_000, stdio: "ignore", windowsHide: true,
        });
        console.log("[tls] Certificate auto-trusted in Windows cert store");
      } catch {
        console.warn("[tls] Could not auto-trust cert. You may see a browser warning on first visit.");
      }
    }

    return { cert, key };
  } catch (e) {
    console.warn(`[tls] Certificate generation failed: ${(e as Error).message}`);
    return null;
  }
}

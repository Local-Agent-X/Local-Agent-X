import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * TLS Certificate Management
 *
 * Auto-generates a self-signed certificate on first run for HTTPS localhost.
 * On Windows, auto-trusts the cert so the browser shows no warnings.
 *
 * Cert stored in ~/.sax/tls/cert.pem + key.pem
 * Valid for 825 days, checked by reading cert text.
 */

export interface TLSCert {
  cert: string;
  key: string;
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
      // Simple validity check: cert should contain PEM markers
      if (cert.includes("BEGIN CERTIFICATE") && key.includes("BEGIN PRIVATE KEY")) {
        // Check expiry using openssl
        try {
          execFileSync("openssl", ["x509", "-in", certPath, "-checkend", "86400", "-noout"], {
            timeout: 5000,
            stdio: "ignore",
          });
          return { cert, key }; // Valid
        } catch {
          console.log("[tls] Certificate expired or invalid, regenerating...");
        }
      }
    } catch {}
  }

  // Generate new cert
  console.log("[tls] Generating self-signed certificate for localhost...");
  mkdirSync(tlsDir, { recursive: true });

  try {
    // Write a minimal openssl config file (avoids shell quoting issues)
    const confPath = join(tlsDir, "openssl.cnf");
    const conf = `[req]
default_bits = 2048
prompt = no
distinguished_name = dn
x509_extensions = v3_ext

[dn]
CN = localhost
O = SecretAgentX

[v3_ext]
subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1
basicConstraints = CA:TRUE
`;
    writeFileSync(confPath, conf);

    // Generate cert using config file (no shell escaping issues)
    execFileSync("openssl", [
      "req", "-x509",
      "-newkey", "rsa:2048",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "825",
      "-nodes",
      "-config", confPath,
    ], {
      timeout: 15_000,
      stdio: "ignore",
      windowsHide: true,
    });

    const cert = readFileSync(certPath, "utf-8");
    const key = readFileSync(keyPath, "utf-8");

    if (!cert.includes("BEGIN CERTIFICATE")) {
      throw new Error("Generated cert is invalid");
    }

    console.log("[tls] Certificate generated successfully");

    // Auto-trust on Windows
    if (process.platform === "win32") {
      trustCertWindows(certPath);
    }

    return { cert, key };
  } catch (e) {
    console.warn(`[tls] Certificate generation failed: ${(e as Error).message}`);
    console.warn("[tls] Falling back to HTTP. Ensure 'openssl' is in your PATH.");
    return null;
  }
}

/**
 * Auto-trust cert on Windows (CurrentUser store, no admin needed).
 */
function trustCertWindows(certPath: string): void {
  try {
    execFileSync("certutil", ["-user", "-addstore", "Root", certPath], {
      timeout: 10_000,
      stdio: "ignore",
      windowsHide: true,
    });
    console.log("[tls] Certificate auto-trusted in Windows cert store");
  } catch {
    console.warn("[tls] Could not auto-trust cert. You may see a browser warning on first visit.");
  }
}

export function isOpenSSLAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

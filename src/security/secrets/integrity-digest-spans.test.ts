// A content digest is not a guessed password. Measured 2026-11-23: a deploy of
// a project with a package-lock.json came back from the publish review as
// 1,170 "could be a password or access key" findings, one per `integrity` line.
import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { integrityDigestSpans } from "./integrity-digest-spans.js";
import { scanForSecrets } from "./secret-scanner.js";

const sri = (alg: "sha1" | "sha256" | "sha384" | "sha512", data = randomBytes(64)) =>
  `${alg}-${createHash(alg).update(data).digest("base64")}`;

// Real lines from an npm lockfile.
const LOCKFILE = `{
  "packages": {
    "node_modules/@babel/core": {
      "version": "7.26.0",
      "resolved": "https://registry.npmjs.org/@babel/core/-/core-7.26.0.tgz",
      "integrity": "sha512-6OzddxPio9UiWTCemp4N8cYLV2ZN1ncRnV1cVGtve7dhPOtRkleRyx32GQCYSwDYgaHU3USMm84tNsvKzRCa1Q==",
      "license": "MIT"
    },
    "node_modules/x": {
      "integrity": "sha512-Aup7aUOfpbAUg2ROOJN6Iw5f9DMBlzu0mIkm/malLQFN/YQgO48wCj0Kxa3sEHJvPVFg7siR+qRInwXd2qhQKw=="
    }
  }
}`;

describe("integrity digests are not guessed keys", () => {
  it("an npm lockfile's integrity lines scan clean", () => {
    expect(scanForSecrets(LOCKFILE).matches).toEqual([]);
  });

  it("every SRI algorithm, in a lockfile, a pnpm lockfile and a script tag", () => {
    for (const alg of ["sha1", "sha256", "sha384", "sha512"] as const) {
      const digest = sri(alg);
      for (const text of [
        `"integrity": "${digest}"`,
        `resolution: {integrity: ${digest}}`,
        `<script src="/app.js" integrity="${digest}" crossorigin="anonymous"></script>`,
      ]) {
        expect(scanForSecrets(text).matches, `${alg}: ${text}`).toEqual([]);
      }
    }
  });

  it("a Yarn lockfile's SHA-512 hex checksum scans clean", () => {
    const hex = createHash("sha512").update(randomBytes(64)).digest("hex");
    expect(scanForSecrets(`  checksum: ${hex}\n  checksum: 10c0/${hex}`).matches).toEqual([]);
  });

  it("the span is the digest's body, not the algorithm name", () => {
    const digest = sri("sha512");
    const text = `"integrity": "${digest}"`;
    const start = text.indexOf(digest) + "sha512-".length;
    expect(integrityDigestSpans(text)).toEqual([[start, start + digest.length - "sha512-".length]]);
  });

  it("a key behind the prefix is still a key when it is not a digest's size", () => {
    // 48 random bytes under a sha512 name: not a SHA-512 digest.
    const key = randomBytes(48).toString("base64url");
    expect(integrityDigestSpans(`sha512-${key}`)).toEqual([]);
    expect(scanForSecrets(`"integrity": "sha512-${key}"`).clean).toBe(false);
  });

  it("a digest under the wrong algorithm's name is not exempt", () => {
    const sha256Body = sri("sha256").slice("sha256-".length);
    expect(integrityDigestSpans(`sha512-${sha256Body}`)).toEqual([]);
  });

  it("a bare random token with no digest name is still flagged", () => {
    expect(scanForSecrets(`token: ${randomBytes(40).toString("base64url")}`).clean).toBe(false);
  });
});

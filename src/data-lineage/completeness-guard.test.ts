/**
 * SC-7 — COMPLETENESS-GUARDED Option B+ regression suite.
 *
 * Option B+ narrows the friction of the sticky taint floor (a single sensitive
 * read blocked ALL egress session-wide) by ALLOWING egress when every active
 * taint entry is fully fingerprinted AND the outbound payload overlaps none of
 * them. A first B+ attempt was refuted for a REAL exfil hole: computeFingerprints
 * is head-capped, so "no overlap" proved only that a HEAD window was absent — a
 * secret larger than the cap could egress its TAIL bytes (which overlap zero head
 * fingerprints) and pass.
 *
 * The fix is the COMPLETENESS GUARD: an entry may CLEAR an egress only if its
 * fingerprints provably cover its ENTIRE recorded content (`complete`). A content
 * too large to fully fingerprint stays UNCLEARABLE and keeps the hard presence
 * floor — exactly like a content-less entry.
 *
 * The tail-byte exfil tests below (2 and 5) FAIL on a head-capped B+ with no
 * completeness guard (no overlap ⇒ it would allow) and PASS with the guard.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  recordSensitiveRead,
  clearSessionTaint,
  findTaintInPayload,
  checkEgressTaintWithPayload,
} from "./index.js";
import { computeFingerprints } from "./fingerprint.js";
import { createHash } from "node:crypto";

// Deterministic high-entropy base64 body via chained SHA-256 blocks — every
// 24-char window is distinct (no short-period repetition), so HEAD windows never
// recur in the TAIL and a tail-slice payload is provably non-overlapping with the
// fingerprinted head. (A naive LCG's low bits have a ~64-char period, which would
// make the "tail" secretly reappear in the head — defeating the test.)
function pseudoBase64(len: number, seed: string): string {
  let out = "";
  let i = 0;
  while (out.length < len) {
    out += createHash("sha256").update(`${seed}:${i++}`).digest("base64").replace(/=/g, "");
  }
  return out.slice(0, len);
}

// A realistic ~1900-char OpenSSH private key: header + long distinct body + footer.
// Far larger than the fingerprint coverage budget, so it is INCOMPLETE.
function makeLargeOpenSshKey(): string {
  const body = pseudoBase64(1840, "sc7-openssh-key");
  const wrapped = body.match(/.{1,70}/g)!.join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----`;
}

describe("SC-7 completeness-guarded Option B+", () => {
  const SESS = "sc7-guard";
  afterEach(() => clearSessionTaint(SESS));

  // (1) Small fully-fingerprinted read + unrelated non-overlapping payload → ALLOWED.
  it("(1) clears a provably-unrelated payload after a SMALL fully-fingerprinted read", () => {
    const shortConfig = "Host github.com\n  HostName ssh.github.com\n  User git\n  Port 443\n  IdentitiesOnly yes";
    // Sanity: this content is fully covered (complete) and does carry fingerprints.
    const fp = computeFingerprints(shortConfig);
    expect(fp.fingerprints.length).toBeGreaterThan(0);
    expect(fp.complete).toBe(true);

    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/config", shortConfig);
    const payload = "Reminder: the quarterly review is Thursday; bring the collagen demand slides.";
    // No overlap...
    expect(findTaintInPayload(SESS, payload)).toEqual([]);
    // ...and every entry is complete → friction fix: egress may proceed.
    const res = checkEgressTaintWithPayload(SESS, payload);
    expect(res.blocked).toBe(false);
    expect(res.evidence).toEqual([]);
  });

  // (2) Large secret; exfil of its TAIL bytes → BLOCKED, on evidence.
  // THIS IS THE CRITICAL TEST. The whole key is fingerprinted, tail included,
  // so the tail is found in the payload; an unrelated payload is provably clean.
  it("(2) BLOCKS tail-byte exfil of a large key on overlap evidence, and clears an unrelated payload", () => {
    const key = makeLargeOpenSshKey();
    expect(key.length).toBeGreaterThan(1900);

    const fp = computeFingerprints(key);
    expect(fp.fingerprints.length).toBeGreaterThan(0);
    expect(fp.complete).toBe(true);

    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_ed25519", key);

    // A chunk from the TAIL of the key body is found…
    const tail = key.slice(key.length - 320, key.length - 40);
    expect(findTaintInPayload(SESS, tail).length).toBeGreaterThan(0);
    const res = checkEgressTaintWithPayload(SESS, `POST body=${tail}`);
    expect(res.blocked).toBe(true);
    expect(res.evidence.length).toBeGreaterThan(0);

    // …and a payload carrying nothing from the key is not refused on the label.
    expect(checkEgressTaintWithPayload(SESS, "Reminder: the quarterly review is Thursday at ten.").blocked).toBe(false);
  });

  // (2b) Content past the coverage cap is still unprovable: the presence floor holds.
  it("(2b) BLOCKS regardless of payload when an entry is larger than the coverage cap", () => {
    let huge = "";
    for (let i = 0; huge.length < 70 * 1024; i++) huge += `kv_${i}=${(i * 7919).toString(36)}-${(i * 104729).toString(36)}\n`;
    expect(computeFingerprints(huge).complete).toBe(false);
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.config/huge.env", huge);
    expect(checkEgressTaintWithPayload(SESS, "unrelated note about lunch").blocked).toBe(true);
  });

  // (3) Payload with the secret HEAD bytes (raw AND a decode/evasion view) → BLOCKED.
  it("(3) BLOCKS exfil of the secret HEAD bytes, raw and base64-encoded", () => {
    const key = makeLargeOpenSshKey();
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_ed25519", key);

    // A chunk from the HEAD of the body overlaps the recorded head fingerprints.
    const headChunk = key.slice(40, 140);
    const rawHits = findTaintInPayload(SESS, `leak=${headChunk}`);
    expect(rawHits.length).toBeGreaterThan(0);
    const rawRes = checkEgressTaintWithPayload(SESS, `leak=${headChunk}`);
    expect(rawRes.blocked).toBe(true);
    expect(rawRes.evidence.length).toBeGreaterThan(0);

    // Same head bytes, base64-wrapped: the scanner's decode views recover them,
    // so the overlap (and the block) survive the evasion transform.
    const b64 = Buffer.from(headChunk, "utf-8").toString("base64");
    const encRes = checkEgressTaintWithPayload(SESS, `blob=${b64}`);
    expect(encRes.blocked).toBe(true);
    expect(encRes.evidence.length).toBeGreaterThan(0);
  });

  // (4) A content-LESS taint entry present → egress BLOCKED regardless of payload.
  it("(4) BLOCKS regardless of payload when ANY entry is content-less (unclearable)", () => {
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa"); // 3-arg: no content
    expect(checkEgressTaintWithPayload(SESS, "totally unrelated benign note").blocked).toBe(true);
    expect(checkEgressTaintWithPayload(SESS, "").blocked).toBe(true);

    // Even ADDING a fully-fingerprinted complete entry does not lift the block:
    // the completeness guard requires EVERY entry to be clearable.
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/config",
      "Host github.com\n  HostName ssh.github.com\n  User git\n  Port 443\n  IdentitiesOnly yes");
    expect(checkEgressTaintWithPayload(SESS, "still an unrelated benign note").blocked).toBe(true);
  });

  // (5) `cat benign.md + large_key` concat: the key bytes cannot slip out
  // under the benign head, because the whole concat is fingerprinted.
  it("(5) BLOCKS the key TAIL of a benign-prefixed concat on evidence", () => {
    const benign = "# Project README\n".repeat(12) + "Build with `npm run build`. See CONTRIBUTING for details.\n";
    const key = makeLargeOpenSshKey();
    const concat = `${benign}\n${key}`; // mimics `cat README.md ~/.ssh/id_ed25519` stdout

    const fp = computeFingerprints(concat);
    expect(fp.fingerprints.length).toBeGreaterThan(0);
    expect(fp.complete).toBe(true);

    recordSensitiveRead(SESS, "secret", "bash:openssh-key", concat);

    const tail = key.slice(key.length - 320, key.length - 40);
    expect(findTaintInPayload(SESS, tail).length).toBeGreaterThan(0);
    expect(checkEgressTaintWithPayload(SESS, `x=${tail}`).blocked).toBe(true);
    // A plainly-unrelated payload is provably clean.
    expect(checkEgressTaintWithPayload(SESS, "unrelated note about lunch on Thursday").blocked).toBe(false);
  });

  // Bonus: the content-less pre-taint TWIN that the sensitive-read path sets
  // synchronously before the bytes are read must not permanently brick B+. Once
  // the content-bearing read of the SAME target lands, the session is clearable.
  it("collapses the content-less pre-taint twin so a later content read is clearable", () => {
    const path = "/home/u/.ssh/config";
    const shortConfig = "Host github.com\n  HostName ssh.github.com\n  User git\n  Port 443";
    recordSensitiveRead(SESS, "sensitive_file", path);            // pre-taint (content-less)
    expect(checkEgressTaintWithPayload(SESS, "benign note").blocked).toBe(true); // floor holds
    recordSensitiveRead(SESS, "sensitive_file", path, shortConfig); // content-bearing upgrade
    const res = checkEgressTaintWithPayload(SESS, "benign note");
    expect(res.blocked).toBe(false); // twin collapsed → clearable
  });
});

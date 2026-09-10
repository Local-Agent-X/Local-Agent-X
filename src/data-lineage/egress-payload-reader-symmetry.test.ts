/**
 * Egress-payload READER SYMMETRY — the three gates that read one outbound payload.
 *
 * `probeDataLineage`, `probeCanary` and the secrets/egress guard
 * (tool-execution/egress-gates.ts) are all handed the SAME outbound payload
 * string for the SAME tool call. They are independent readers of one piece of
 * work, so any length/coverage limit one of them applies and the others do not
 * is an asymmetry — and the reader with the limit is where a padded payload
 * slips through while the other two still look healthy.
 *
 * This suite pins the two readers that scan the payload IN FULL, at an offset
 * far past any head window either could plausibly grow. It is a guard against a
 * future "bound the work" change quietly introducing a head cap in the canary
 * tripwire or the secret scanner: both must keep matching at depth.
 *
 * It deliberately does NOT assert anything about the taint-overlap reader past
 * its head window — that reader's payload-side coverage bound is a live,
 * separately-tracked finding, and pinning today's behavior there would read as
 * blessing it. What IS pinned here is the taint reader's baseline: an overlap at
 * offset 0 is found, so a regression that blinded it entirely still fails.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { recordSensitiveRead, clearSessionTaint, findTaintInPayload } from "./index.js";
import {
  generateCanaries,
  registerSessionCanaries,
  clearSessionCanaries,
  checkCanariesInPayload,
} from "../threat/canaries.js";
import { scanForSecrets } from "../security/secrets/secret-scanner.js";

/** Deterministic filler with no repeating short period, so a padded payload can
 *  never accidentally reproduce the material we are looking for. */
function filler(len: number, seed: string): string {
  let out = "";
  let i = 0;
  while (out.length < len) out += createHash("sha256").update(`${seed}:${i++}`).digest("hex");
  return out.slice(0, len);
}

const SESSION = "reader-symmetry-session";
const DEEP = 70 * 1024; // comfortably past every head window in this stack

afterEach(() => {
  clearSessionTaint(SESSION);
  clearSessionCanaries(SESSION);
});

describe("egress-payload readers scan the whole payload", () => {
  it("canary tripwire matches a token buried past 70KB of padding", () => {
    const canaries = generateCanaries();
    registerSessionCanaries(SESSION, canaries);
    const payload = `${filler(DEEP, "canary-pad")}${canaries[0]}`;
    expect(checkCanariesInPayload(SESSION, payload)).not.toBeNull();
  });

  it("secret scanner matches a credential buried past 70KB of padding", () => {
    const key = `sk-ant-api03-${"A".repeat(95)}`;
    const result = scanForSecrets(`${filler(DEEP, "secret-pad")} ${key}`);
    expect(result.clean).toBe(false);
  });

  it("taint overlap is found when the tainted bytes lead the payload", () => {
    const secret = filler(200, "tainted");
    recordSensitiveRead(SESSION, "sensitive_file", "/tmp/cfg", secret);
    expect(findTaintInPayload(SESSION, `${secret} trailing text`)).toHaveLength(1);
  });
});

/**
 * Contract test for the plug-and-play conformance gate itself.
 *
 * The gate's value depends entirely on it being a RATCHET: today's known
 * violations are held in a baseline, a NEW violation fails the build, and a
 * baseline entry that stops reproducing also fails so the list can only shrink.
 * If any of those three properties silently broke, the gate would keep printing
 * "OK" while the registry drifted back to model-locked. Hence this test.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(root, "scripts/check-integration-conformance.mjs");
const BASELINE = join(root, "scripts/integration-conformance-baseline.json");
const EMAIL = join(root, "src/integrations/builtins/email.ts");
const GITHUB = join(root, "src/integrations/builtins/github.ts");
const TYPES = join(root, "src/integrations/types.ts");

function runGate() {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd: root });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Run the gate against a mutated baseline, always restoring the original. */
function withBaseline(mutate: (b: { known: { id: string; note?: string }[] }) => void) {
  const original = readFileSync(BASELINE, "utf8");
  try {
    const parsed = JSON.parse(original);
    mutate(parsed);
    writeFileSync(BASELINE, JSON.stringify(parsed, null, 2), "utf8");
    return runGate();
  } finally {
    writeFileSync(BASELINE, original, "utf8");
  }
}

/**
 * Run the gate against a temporarily mutated SOURCE file, always restoring it.
 *
 * The baseline is empty as of C7b, so a fresh finding can no longer be
 * synthesised by deleting a baseline entry — it has to come from a declaration
 * that actually violates a rule. That is the stronger test anyway: it exercises
 * the checks, not just the ratchet bookkeeping.
 */
function withSource(file: string, mutate: (text: string) => string) {
  const original = readFileSync(file, "utf8");
  try {
    const mutated = mutate(original);
    if (mutated === original) throw new Error(`mutation for ${file} matched nothing — the test is not testing anything`);
    writeFileSync(file, mutated, "utf8");
    return runGate();
  } finally {
    writeFileSync(file, original, "utf8");
  }
}

describe("integration conformance gate", () => {
  it("passes on the current tree with an empty backlog", () => {
    const { code, out } = runGate();
    expect(code).toBe(0);
    expect(out).toMatch(/check-integration-conformance: OK/);
    // The backlog is empty as of C7b — both remaining entries were earned out
    // (secret:email was a stale-checker false positive, transport:email's route
    // half was fixed). A non-empty backlog must still print itself.
    expect(out).toMatch(/0 known violation\(s\) in baseline/);
    expect(out).not.toMatch(/KNOWN violation\(s\) held in the baseline/);
  });

  // ── The two checks C7b repaired, pinned by what they no longer flag ──

  it("does not flag a correctly-declared multi-credential integration", () => {
    // email declares all nine values its runtime resolves and its instructions
    // ask for. CHECK 4 used to measure them against the PRIMARY alone and call
    // eight of them unstorable, which stopped being true when the install path
    // began persisting the whole declared list.
    const { out } = runGate();

    expect(out).not.toMatch(/secret:email/);
  });

  it("still flags a credential the runtime resolves and the declaration omits", () => {
    // The rule is "resolved but never DECLARED", not "not the primary" — so
    // un-declaring one must bring the finding straight back.
    const { code, out } = withSource(EMAIL, t => t.replace(/name: "IMAP_PASS",/, 'name: "IMAP_PASSPHRASE",'));

    expect(code).toBe(1);
    expect(out).toMatch(/secret:email/);
    expect(out).toMatch(/IMAP_PASS/);
  });

  it("does not flag an integration that DECLARES a non-HTTP transport", () => {
    // An empty baseUrl plus smtp/imap pseudo-paths is the CORRECT shape for an
    // integration that says it is not an HTTP API.
    const { out } = runGate();

    expect(out).not.toMatch(/transport:email/);
  });

  it("flags the same declaration the moment it stops declaring its transport", () => {
    const { code, out } = withSource(EMAIL, t => t.replace(/\n  transport: "smtp_imap",/, ""));

    expect(code).toBe(1);
    expect(out).toMatch(/transport:email/);
    expect(out).toMatch(/baseUrl is empty/);
  });

  it("flags a transport the runtime does not know, which degrades to http", () => {
    const { code, out } = withSource(EMAIL, t => t.replace('transport: "smtp_imap"', 'transport: "carrier_pigeon"'));

    expect(code).toBe(1);
    expect(out).toMatch(/transport:email/);
    expect(out).toMatch(/normalizeTransport\(\) does not know/);
  });

  it("flags a non-HTTP transport that also declares a baseUrl", () => {
    const { code, out } = withSource(EMAIL, t => t.replace('baseUrl: ""', 'baseUrl: "https://mail.example.com"'));

    expect(code).toBe(1);
    expect(out).toMatch(/transport:email/);
    expect(out).toMatch(/one of the two is a lie/);
  });

  it("hard-fails when it can no longer parse TRANSPORT_TOOLS, instead of auditing blind", () => {
    // NON_HTTP_TRANSPORTS is read out of src/integrations/types.ts rather than
    // re-listed, so a shape change there empties the set — and an EMPTY set is
    // not a safe default: every declared non-HTTP transport becomes "one
    // normalizeTransport() does not know". The gate would still be red, but for
    // a fabricated reason, and a genuinely-unknown transport would be
    // indistinguishable from a parser that stopped working. Hence the guard,
    // which is why the message is asserted and not just the exit code.
    //
    // The mutation is a legal TS shape change (a quoted key), not a syntax
    // break, so it is exactly the drift the guard exists for.
    const { code, out } = withSource(TYPES, t => t.replace(/^  smtp_imap:/m, '  "smtp_imap":'));

    expect(code).toBe(1);
    expect(out).toMatch(/parsed 0 non-HTTP transports/);
  });

  it("audits every registered builtin integration", () => {
    const { out } = runGate();
    const count = Number(out.match(/OK \((\d+) integrations/)?.[1]);
    const index = readFileSync(join(root, "src/integrations/builtins/index.ts"), "utf8");
    const registered = [...index.matchAll(/^\s*(\w+Integration),$/gm)].length;
    expect(count).toBe(registered);
    expect(count).toBeGreaterThanOrEqual(11);
  });

  it("fails on a violation that is not in the baseline (new violation)", () => {
    const { code, out } = withSource(GITHUB, t => t.replace('baseUrl: "https://api.github.com"', 'baseUrl: ""'));
    expect(code).toBe(1);
    expect(out).toMatch(/new plug-and-play violation/);
    expect(out).toMatch(/transport:github/);
  });

  it("fails on a stale baseline entry so the list can only shrink", () => {
    const { code, out } = withBaseline((b) => {
      b.known.push({ id: "steer:a_tool_that_does_not_exist", note: "synthetic" });
    });
    expect(code).toBe(1);
    expect(out).toMatch(/no longer reproduce/);
  });

  it("restores the baseline and the sources after mutation", () => {
    expect(JSON.parse(readFileSync(BASELINE, "utf8")).known).toEqual([]);
    expect(readFileSync(EMAIL, "utf8")).toContain('transport: "smtp_imap"');
    expect(readFileSync(GITHUB, "utf8")).toContain('baseUrl: "https://api.github.com"');
    expect(readFileSync(TYPES, "utf8")).toContain("\n  smtp_imap: [");
    expect(runGate().code).toBe(0);
  });
});

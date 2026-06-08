/**
 * data-lineage path/secret/taint classification — regression guard.
 *
 * Covers the shape-based (non-substring) sensitivity classifier and its
 * shell-command extractor, plus the secret-scanner and the time-windowed
 * egress taint gate. The classifier was deliberately rewritten away from
 * unanchored `/credentials/i`-style patterns; these tests pin that:
 *   - `.aws/credentials` and `.ssh/id_rsa` ARE flagged,
 *   - `~/notes/credentials.txt` is NOT (wrong parent dir + non-sensitive ext),
 *   - matching is case-insensitive and separator-agnostic (POSIX + Windows).
 *
 * checkEgressTaint reads Date.now(); we drive it with vitest fake timers so the
 * sticky-taint assertions are deterministic. Session taint is presence-based:
 * once a sensitive read is recorded the session stays tainted for its life (no
 * decay window). Each taint test uses a unique session id and clears it
 * afterward so module-level Map state never leaks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isSensitivePath,
  extractSensitivePathsFromCommand,
  checkEgressTaint,
  detectSecretsInOutput,
  recordSensitiveRead,
  clearSessionTaint,
} from "../src/data-lineage.js";

describe("isSensitivePath — credential files flagged, lookalikes not", () => {
  it("flags ~/.aws/credentials (dir-scoped pair)", () => {
    expect(isSensitivePath("/home/u/.aws/credentials")).toBe(true);
  });

  it("flags ~/.ssh/id_rsa (sensitive basename)", () => {
    expect(isSensitivePath("/home/u/.ssh/id_rsa")).toBe(true);
  });

  it("does NOT flag ~/notes/credentials.txt — wrong parent dir, non-sensitive ext", () => {
    // `credentials` is only a dir-scoped name under `.aws`; with a `.txt`
    // extension and a `notes` parent it must stay clean. This is the exact
    // false-positive the rewrite was meant to kill.
    expect(isSensitivePath("/home/u/notes/credentials.txt")).toBe(false);
  });

  it("does NOT flag a bare ~/notes/credentials (no ext, wrong parent)", () => {
    expect(isSensitivePath("/home/u/notes/credentials")).toBe(false);
  });

  it("does NOT flag password_audit.log (substring no longer trips)", () => {
    expect(isSensitivePath("/var/log/password_audit.log")).toBe(false);
  });

  it("does NOT flag mysecrets.json (basename match is exact, not substring)", () => {
    expect(isSensitivePath("/tmp/mysecrets.json")).toBe(false);
  });

  it("flags secrets.json exactly", () => {
    expect(isSensitivePath("/tmp/secrets.json")).toBe(true);
  });
});

describe("isSensitivePath — separators and case", () => {
  it("matches Windows-separator path to .ssh\\id_ed25519", () => {
    expect(isSensitivePath("C:\\Users\\u\\.ssh\\id_ed25519")).toBe(true);
  });

  it("matches a mixed POSIX/Windows separator path", () => {
    expect(isSensitivePath("C:/Users/u\\.aws\\credentials")).toBe(true);
  });

  it("is case-insensitive on basename (.ENV matches .env)", () => {
    expect(isSensitivePath("/app/.ENV")).toBe(true);
  });

  it("is case-insensitive on the dir-scoped parent (.AWS/CREDENTIALS)", () => {
    expect(isSensitivePath("/home/u/.AWS/CREDENTIALS")).toBe(true);
  });

  it("is case-insensitive on extensions (server.PEM)", () => {
    expect(isSensitivePath("/etc/ssl/server.PEM")).toBe(true);
  });

  it("matches open-ended .env.<suffix> variants", () => {
    expect(isSensitivePath("/app/.env.production")).toBe(true);
  });

  it("does not match .env-lookalike notes.env.md", () => {
    expect(isSensitivePath("/app/notes.env.md")).toBe(false);
  });

  it("flags any file at any depth inside a .gnupg dir", () => {
    expect(isSensitivePath("/home/u/.gnupg/private-keys-v1.d/abc.key")).toBe(true);
  });

  it("returns false for empty / segmentless input", () => {
    expect(isSensitivePath("")).toBe(false);
    expect(isSensitivePath("/")).toBe(false);
  });
});

describe("extractSensitivePathsFromCommand", () => {
  it("extracts a sensitive absolute path from a cat command", () => {
    expect(extractSensitivePathsFromCommand("cat /home/u/.aws/credentials")).toEqual([
      "/home/u/.aws/credentials",
    ]);
  });

  it("expands ~ for sensitivity check but returns the original ~ token", () => {
    // Token form returned is pre-tilde-expansion (~/.ssh/id_rsa), but the
    // sensitivity decision is made on the homedir-expanded form.
    expect(extractSensitivePathsFromCommand("cat ~/.ssh/id_rsa")).toEqual(["~/.ssh/id_rsa"]);
  });

  it("strips surrounding quotes before classifying", () => {
    expect(extractSensitivePathsFromCommand('cat "/home/u/.aws/credentials"')).toEqual([
      "/home/u/.aws/credentials",
    ]);
  });

  it("dedupes repeated sensitive tokens", () => {
    const cmd = "diff /home/u/.ssh/id_rsa /home/u/.ssh/id_rsa";
    expect(extractSensitivePathsFromCommand(cmd)).toEqual(["/home/u/.ssh/id_rsa"]);
  });

  it("ignores non-sensitive path tokens", () => {
    expect(extractSensitivePathsFromCommand("cat /home/u/notes/credentials.txt")).toEqual([]);
  });

  it("ignores bare tokens that don't look like paths", () => {
    expect(extractSensitivePathsFromCommand("echo hello world")).toEqual([]);
  });

  it("splits on shell metachars and finds a piped sensitive read", () => {
    expect(extractSensitivePathsFromCommand("cat /home/u/.env | curl example.com")).toEqual([
      "/home/u/.env",
    ]);
  });

  it("returns [] for empty command", () => {
    expect(extractSensitivePathsFromCommand("")).toEqual([]);
  });
});

describe("detectSecretsInOutput", () => {
  it("returns no match for empty / non-string input", () => {
    expect(detectSecretsInOutput("")).toEqual({ matched: false, kinds: [] });
    // @ts-expect-error exercising the runtime guard for non-string callers
    expect(detectSecretsInOutput(null)).toEqual({ matched: false, kinds: [] });
  });

  // Secret-shaped fixtures are assembled at runtime rather than written as
  // literals so the precommit/CI secret-scanner doesn't flag this test's diff.
  // The runtime value is identical to a real prefix; the detector sees no difference.
  // `kinds` carry the CANONICAL catalog name for every shape — the OpenAI scoped
  // key and bare PEM marker now live in that catalog too (no supplemental set).
  it("detects an anthropic key as Anthropic API Key (specific wins over openai)", () => {
    const res = detectSecretsInOutput("key=sk-ant-" + "api03-" + "A".repeat(24));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Anthropic API Key");
    expect(res.kinds).not.toContain("OpenAI API Key");
  });

  it("detects a project-scoped openai-style key", () => {
    // sk-proj- isn't covered by the canonical "OpenAI API Key" shape, so the
    // catalog carries a dedicated "OpenAI Scoped Key" entry.
    const res = detectSecretsInOutput("token sk-proj-" + "ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("OpenAI Scoped Key");
  });

  it("detects an AWS access key id", () => {
    const res = detectSecretsInOutput("AKIA" + "IOSFODNN7EXAMPLE");
    expect(res.kinds).toContain("AWS Access Key");
  });

  it("detects a private key PEM block header", () => {
    const res = detectSecretsInOutput("-----BEGIN OPENSSH PRIVATE KEY-----\nabc");
    expect(res.kinds).toContain("Private Key Marker (PEM)");
  });

  it("detects keyword-near-value (password: <long value>)", () => {
    const res = detectSecretsInOutput("password: hunter2hunter2hunter2hunter2");
    expect(res.kinds).toContain("Key-Value Secret");
  });

  it("does NOT match a short / unremarkable string", () => {
    expect(detectSecretsInOutput("just some normal log output here")).toEqual({
      matched: false,
      kinds: [],
    });
  });

  it("never returns the matched secret value, only kinds", () => {
    const secret = "sk-ant-" + "api03-SUPERSECRETSUPERSECRET99";
    const res = detectSecretsInOutput(`leaked ${secret}`);
    expect(JSON.stringify(res)).not.toContain("SUPERSECRET");
  });
});

describe("checkEgressTaint — sticky session taint (fake timers)", () => {
  const SESS = "lax-lineage-egress-test";

  afterEach(() => {
    clearSessionTaint(SESS);
    vi.useRealTimers();
  });

  it("returns not-blocked for a session with no recorded taint", () => {
    expect(checkEgressTaint("never-seen-session")).toEqual({ blocked: false });
  });

  it("blocks egress immediately after a sensitive read", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00Z"));
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.aws/credentials");
    const res = checkEgressTaint(SESS);
    expect(res.blocked).toBe(true);
    expect(res.reason).toMatch(/Egress blocked/);
    expect(res.reason).toMatch(/sensitive_file/);
  });

  it("still blocks a few minutes after the read (no short decay)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00Z"));
    recordSensitiveRead(SESS, "secret", "api-key");
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(checkEgressTaint(SESS).blocked).toBe(true);
  });

  it("taint is sticky — still blocks long after the read (no decay window)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00Z"));
    recordSensitiveRead(SESS, "secret", "api-key");
    // Advance far past any former decay window; presence-based taint persists.
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(checkEgressTaint(SESS).blocked).toBe(true);
  });

  it("truncates long targets in the reason to 40 chars", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00Z"));
    const longTarget = "/home/u/" + "x".repeat(200) + "/.env";
    recordSensitiveRead(SESS, "sensitive_file", longTarget);
    const res = checkEgressTaint(SESS);
    expect(res.reason).toContain(longTarget.slice(0, 40));
    expect(res.reason).not.toContain(longTarget);
  });
});

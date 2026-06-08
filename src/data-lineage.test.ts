import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  extractSensitivePathsFromCommand,
  recordSensitiveRead,
  checkEgressTaint,
  clearSessionTaint,
  isSensitivePath,
  isSensitiveAttachmentPath,
  detectSecretsInOutput,
  redactSecretSpans,
  getKernelTaintSources,
  propagateTaint,
  findTaintInPayload,
  checkEgressTaintWithPayload,
  declassifySession,
  declassifyTaintSource,
  _setDeclassifyAuditTrail,
} from "./data-lineage.js";
import { Handler } from "./agency/handler.js";
import { CryptoAuditTrail } from "./threat/audit-trail.js";
import { runSandboxedPhase } from "./tool-execution/run-sandboxed.js";
import type { ToolCallContext } from "./tool-execution/context.js";
import type { ToolDefinition } from "./types.js";

describe("isSensitivePath — pattern spec table", () => {
  // The test table IS the spec. Each row is (path, expected). False-positive
  // rows come from the regex-too-broad incident (Bug 5): substring matches on
  // `password`, `credentials`, `secret`, `.env`, `.config` flagged docs, logs,
  // source files, and other-named directories as sensitive, eroding signal.
  const cases: Array<[string, boolean, string?]> = [
    // -- True positives --
    ["/Users/x/.aws/credentials", true],
    ["/Users/x/.aws/config", true],
    ["/Users/x/.ssh/id_rsa", true],
    ["/Users/x/.ssh/id_ed25519", true],
    ["/Users/x/.ssh/id_ecdsa", true],
    ["/Users/x/.ssh/id_dsa", true],
    ["/Users/x/.ssh/config", true, "dir-scoped: .ssh/config is the SSH client config"],
    ["/Users/x/.kube/config", true],
    ["/Users/x/.docker/config.json", true],
    ["/Users/x/.config/gcloud/credentials.db", true],
    ["/Users/x/.config/gh/hosts.yml", true],
    ["/etc/ssl/private/server.pem", true],
    ["/etc/ssl/private/server.key", true],
    ["/opt/app/keystore.p12", true],
    ["/opt/app/store.pfx", true],
    ["/opt/app/release.keystore", true],
    ["/Users/x/Library/Keychains/login.keychain-db", true],
    ["/project/.env", true],
    ["/project/.env.local", true],
    ["/project/.env.production", true],
    ["/project/.envrc", true],
    ["/home/x/.npmrc", true],
    ["/home/x/.netrc", true],
    ["/srv/app/secrets.json", true],
    ["/srv/app/secrets.yaml", true],
    ["/srv/app/secrets.toml", true],
    ["/srv/app/credentials.json", true],
    ["/home/x/auth.json", true],
    ["/home/x/.gnupg/secring.gpg", true, "any file inside ~/.gnupg"],
    ["C:\\Users\\me\\.aws\\credentials", true, "windows path separator"],
    ["C:\\Users\\me\\.ssh\\id_rsa", true],

    // -- False positives that the old regexes wrongly flagged --
    ["/Users/x/.configurator/notoken.md", false, "old /\\.config.*token/i fired"],
    ["/var/log/password_audit.log", false, "old /password/i fired"],
    ["/home/x/notes/password.md", false, "user-authored doc with the word in the name"],
    ["/repo/src/tokenizer.py", false, "source file, not a credential"],
    ["/repo/README.md", false, "README content can mention secrets; the file isn't one"],
    ["/repo/docs/secrets.md", false, ".md is not a credential extension"],
    ["/repo/src/secrets.py", false, "source file named after the topic"],
    ["/var/log/credentialserver.log", false, "old /credentials/i substring-matched"],
    ["/home/x/Documents/old_password.txt", false],
    ["/home/x/.ssh/id_rsa.pub", false, "public key — paired with private but not secret"],
    ["/home/x/.ssh/known_hosts", false],
    ["/home/x/.ssh/authorized_keys", false],
    ["/home/x/myproject/config", false, "bare `config` outside known cred dirs"],
    ["/home/x/credentials.txt", false, "wrong extension"],
    ["/srv/app/mysecrets.json", false, "basename must equal `secrets.json`, not contain it"],
    ["", false],
  ];

  for (const [path, expected, note] of cases) {
    const label = note ? `${path}  (${note})` : path;
    it(`${expected ? "flags" : "ignores"}: ${label}`, () => {
      expect(isSensitivePath(path)).toBe(expected);
    });
  }
});

describe("isSensitiveAttachmentPath — egress-attachment sink (stricter)", () => {
  // The attachment sink reads a file AND ships it off-box, so a miss is
  // exfiltration. This predicate is a superset of isSensitivePath with
  // whole-directory rules for the app's own vault (.lax) and credential stores
  // (.ssh, .aws, .gnupg). Finding H6: ~/.lax/secrets.enc, ~/.ssh/deploy_key,
  // and ~/.aws/sso/cache/*.json previously slipped past the guard.
  const home = homedir();
  const cases: Array<[string, boolean, string?]> = [
    // -- Must block (the H6 attack targets) --
    ["~/.lax/secrets.enc", true, "the app's OWN vault — leading ~ resolves via dir segment"],
    [join(home, ".lax", "secrets.enc"), true, "absolute form of the vault"],
    ["~/.ssh/deploy_key", true, "private key with a non-canonical filename"],
    ["~/.ssh/id_ed25519_work", true, "any file under .ssh is a potential key"],
    ["~/.ssh/id_ed25519_anything", true],
    ["~/.aws/sso/cache/abc.json", true, "plaintext SSO token cache"],
    ["~/.aws/credentials", true],
    ["/Users/x/.gnupg/secring.gpg", true, "whole .gnupg dir"],
    ["/srv/app/secrets.enc", true, "encrypted vault container by extension"],
    ["/etc/ssl/private/server.pem", true, "inherited from isSensitivePath"],
    ["/etc/ssl/private/server.key", true, "inherited from isSensitivePath"],
    ["/project/.env", true, "inherited from isSensitivePath"],

    // -- Must NOT block (benign — no taint-storm / no over-blocking) --
    ["~/projects/readme.md", false, "ordinary doc"],
    ["~/.ssh/known_hosts", false, "host fingerprints, low-risk"],
    ["~/.ssh/id_rsa.pub", false, "public key"],
    ["~/.ssh/work.pub", false, "any public key"],
    ["/repo/README.md", false],
    ["/repo/src/secrets.py", false, "source file, not a vault"],
    ["", false],
  ];

  for (const [path, expected, note] of cases) {
    const label = note ? `${path}  (${note})` : path;
    it(`${expected ? "blocks" : "allows"}: ${label}`, () => {
      expect(isSensitiveAttachmentPath(path)).toBe(expected);
    });
  }

  it("covers a relocated LAX_DATA_DIR (dir not literally named .lax)", () => {
    const prev = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = "/var/lib/agentx-state";
    try {
      expect(isSensitiveAttachmentPath("/var/lib/agentx-state/secrets.enc")).toBe(true);
      // A like-named segment elsewhere also trips, which is acceptable
      // over-blocking for an attachment sink.
      expect(isSensitiveAttachmentPath("/home/x/agentx-state/notes.txt")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = prev;
    }
  });
});

describe("extractSensitivePathsFromCommand", () => {
  it("matches POSIX absolute paths to ssh keys", () => {
    const matches = extractSensitivePathsFromCommand("cat /home/user/.ssh/id_rsa");
    expect(matches).toContain("/home/user/.ssh/id_rsa");
  });

  it("matches tilde-expanded paths", () => {
    const matches = extractSensitivePathsFromCommand("cat ~/.ssh/id_rsa");
    // We return the raw token (post-quote-strip, pre-tilde-expansion),
    // but the resolved form must be what isSensitivePath flagged.
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]).toMatch(/\.ssh/);
    // Sanity: confirm the resolution path matches a sensitive pattern.
    const resolved = matches[0].replace(/^~/, homedir());
    expect(isSensitivePath(resolved)).toBe(true);
  });

  it("matches Windows absolute paths", () => {
    const matches = extractSensitivePathsFromCommand("type C:\\Users\\me\\.aws\\credentials");
    expect(matches).toContain("C:\\Users\\me\\.aws\\credentials");
  });

  it("strips surrounding quotes", () => {
    const matches = extractSensitivePathsFromCommand(`cat "/Users/x/.aws/credentials"`);
    expect(matches).toContain("/Users/x/.aws/credentials");
  });

  it("matches single-quoted paths", () => {
    const matches = extractSensitivePathsFromCommand(`cat '/Users/x/.aws/credentials'`);
    expect(matches).toContain("/Users/x/.aws/credentials");
  });

  it("returns multiple matches", () => {
    const matches = extractSensitivePathsFromCommand("cat ~/.ssh/id_rsa ~/.aws/credentials");
    expect(matches.length).toBe(2);
    expect(matches.some(p => p.includes(".ssh"))).toBe(true);
    expect(matches.some(p => p.includes(".aws"))).toBe(true);
  });

  it("does not false-positive on benign commands", () => {
    expect(extractSensitivePathsFromCommand("ls -la")).toEqual([]);
    expect(extractSensitivePathsFromCommand("git status")).toEqual([]);
    expect(extractSensitivePathsFromCommand("echo /something/regular.txt")).toEqual([]);
  });

  it("dedupes repeated paths", () => {
    const matches = extractSensitivePathsFromCommand("cat ~/.ssh/id_rsa && cp ~/.ssh/id_rsa /tmp/x");
    const tildeHits = matches.filter(p => p === "~/.ssh/id_rsa");
    expect(tildeHits.length).toBe(1);
  });

  it("handles empty and whitespace input", () => {
    expect(extractSensitivePathsFromCommand("")).toEqual([]);
    expect(extractSensitivePathsFromCommand("   ")).toEqual([]);
  });

  it("splits on pipes and redirects", () => {
    const matches = extractSensitivePathsFromCommand("cat ~/.ssh/id_rsa | base64");
    expect(matches.some(p => p.includes(".ssh"))).toBe(true);
  });

  it("flags .pem and .key suffixes", () => {
    const matches = extractSensitivePathsFromCommand("openssl rsa -in /etc/ssl/private/server.key");
    expect(matches).toContain("/etc/ssl/private/server.key");
  });
});

describe("bash taint integration", () => {
  beforeEach(() => clearSessionTaint("test-session"));

  it("taints the session via bash command containing sensitive path", () => {
    expect(checkEgressTaint("test-session").blocked).toBe(false);

    // Mirror what run-sandboxed.ts now does for the bash branch.
    const cmd = "cat ~/.ssh/id_rsa";
    const matches = extractSensitivePathsFromCommand(cmd);
    expect(matches.length).toBeGreaterThan(0);
    for (const p of matches) {
      recordSensitiveRead("test-session", "sensitive_file", p);
    }

    const egress = checkEgressTaint("test-session");
    expect(egress.blocked).toBe(true);
    expect(egress.reason).toMatch(/id_rsa|\.ssh/);
  });

  it("does not taint on benign bash commands", () => {
    const matches = extractSensitivePathsFromCommand("ls -la && git status");
    expect(matches).toEqual([]);
    // No recordSensitiveRead calls — session stays clean.
    expect(checkEgressTaint("test-session").blocked).toBe(false);
  });

  it("clearSessionTaint resets the gate", () => {
    recordSensitiveRead("test-session", "sensitive_file", "/home/u/.ssh/id_rsa");
    expect(checkEgressTaint("test-session").blocked).toBe(true);
    clearSessionTaint("test-session");
    expect(checkEgressTaint("test-session").blocked).toBe(false);
  });
});

describe("sticky session taint — no decay window", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearSessionTaint("sticky-session");
  });

  it("egress stays blocked long after the old 5-minute window would have elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T00:00:00Z"));
    clearSessionTaint("sticky-session");

    recordSensitiveRead("sticky-session", "sensitive_file", "/home/u/.ssh/id_rsa");
    expect(checkEgressTaint("sticky-session").blocked).toBe(true);

    // Advance well past the former 5-minute decay window (now +1 hour).
    vi.advanceTimersByTime(60 * 60 * 1000);

    // Sticky semantics: the session is STILL tainted; egress stays blocked.
    expect(checkEgressTaint("sticky-session").blocked).toBe(true);
    // And the kernel still receives the taint source.
    expect(getKernelTaintSources("sticky-session")).toContain("rag");
  });

  it("propagated taint also persists past the old window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T00:00:00Z"));
    clearSessionTaint("sticky-child");
    clearSessionTaint("sticky-session");

    recordSensitiveRead("sticky-child", "sensitive_file", "/home/u/.ssh/id_rsa");
    expect(propagateTaint("sticky-child", "sticky-session")).toBe(1);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(checkEgressTaint("sticky-session").blocked).toBe(true);

    clearSessionTaint("sticky-child");
  });
});

describe("detectSecretsInOutput — positive cases", () => {
  // `kinds` carry the CANONICAL catalog name (credential-patterns.ts). The four
  // shapes that used to live in a local supplemental set (Google keys, JWTs,
  // OpenAI scoped keys, bare PEM markers) are now in that catalog too.
  it("matches OpenAI-style API key", () => {
    const res = detectSecretsInOutput("sk-abc123xyz456789012345");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("OpenAI API Key");
  });

  it("matches Anthropic-style API key", () => {
    const secret = "sk-ant-" + "deadbeef" + "a".repeat(30);
    const res = detectSecretsInOutput(secret);
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Anthropic API Key");
  });

  it("matches AWS access key ID", () => {
    const res = detectSecretsInOutput("AKIAIOSFODNN7EXAMPLE");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("AWS Access Key");
  });

  it("matches AWS secret access key when keyword anchors the line", () => {
    const res = detectSecretsInOutput("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("AWS Secret Key");
  });

  it("matches GitHub PAT (ghp_ form)", () => {
    const res = detectSecretsInOutput("ghp_" + "a".repeat(36));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("GitHub PAT");
  });

  it("matches Slack bot token", () => {
    const res = detectSecretsInOutput("xoxb-1234567890-abcdef123456");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Slack Token");
  });

  it("matches Google API key", () => {
    const res = detectSecretsInOutput("AIza" + "a".repeat(35));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Google API Key");
  });

  it("matches JWT-shaped string", () => {
    const seg = "a".repeat(20);
    const jwt = `eyJ${seg}.eyJ${seg}.${seg}`;
    const res = detectSecretsInOutput(jwt);
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("JWT");
  });

  it("matches private key block markers", () => {
    const res = detectSecretsInOutput("-----BEGIN RSA PRIVATE KEY-----");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Private Key Marker (PEM)");
  });

  it("matches keyword-near-value heuristic", () => {
    const res = detectSecretsInOutput("password: abcdef1234567890ABCDE");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Key-Value Secret");
  });

  // S1 convergence: modern keys that exist in the canonical catalog but were
  // ABSENT from the old inline taint set — previously the egress guard caught
  // them leaving while the taint path did NOT (the documented defect). Now the
  // taint path sources the canonical catalog, so they taint too.
  it("matches a Stripe live key (was missed by the old inline set)", () => {
    const res = detectSecretsInOutput("sk_live_" + "a".repeat(24));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Stripe Live Key");
  });

  it("matches a Supabase token (was missed by the old inline set)", () => {
    const res = detectSecretsInOutput("sbp_" + "a".repeat(24));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Supabase Token");
  });

  it("matches a SendGrid key (was missed by the old inline set)", () => {
    const res = detectSecretsInOutput("SG." + "a".repeat(22) + "." + "b".repeat(22));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("Sendgrid Key");
  });

  it("matches an npm token (was missed by the old inline set)", () => {
    const res = detectSecretsInOutput("npm_" + "a".repeat(36));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("npm Token");
  });
});

describe("detectSecretsInOutput — negative cases", () => {
  it("does not match plain text", () => {
    const res = detectSecretsInOutput("hello world");
    expect(res.matched).toBe(false);
    expect(res.kinds).toEqual([]);
  });

  it("does not match random prose without secret shapes", () => {
    const res = detectSecretsInOutput("some random text without secrets");
    expect(res.matched).toBe(false);
    expect(res.kinds).toEqual([]);
  });

  it("does not match file metadata lines", () => {
    const res = detectSecretsInOutput("file.txt size 1024");
    expect(res.matched).toBe(false);
  });

  it("does not match a plain GitHub URL", () => {
    const res = detectSecretsInOutput("see https://github.com/foo/bar for more");
    expect(res.matched).toBe(false);
  });
});

describe("openai-key pattern precision (false-positive that bricked agent runs)", () => {
  it("does NOT match a hyphenated slug from a public page", () => {
    // Real OpenAI keys have a contiguous base62 body; the old pattern allowed
    // inner `-`/`_`, so a product slug tripped it and tainted the whole run.
    const res = detectSecretsInOutput("order code sk-supplement-formula-2026-batch-xyz here");
    expect(res.matched).toBe(false);
  });

  it("still matches a real legacy key shape", () => {
    const res = detectSecretsInOutput("sk-" + "Ab12".repeat(6));
    expect(res.kinds).toContain("OpenAI API Key");
  });

  it("still matches a project-scoped key shape", () => {
    // Project/service/admin keys aren't covered by the canonical "OpenAI API
    // Key" shape (its body stops at the `-` after `proj`), so the catalog
    // carries a dedicated "OpenAI Scoped Key" entry for them.
    const res = detectSecretsInOutput("sk-proj-" + "Ab12".repeat(8));
    expect(res.kinds).toContain("OpenAI Scoped Key");
  });
});

describe("redactSecretSpans — surgical inline redaction for untrusted inbound content", () => {
  it("replaces the secret span with a marker and keeps surrounding text", () => {
    const body = "Trends report. Contact AKIAIOSFODNN7EXAMPLE for access. The end.";
    const red = redactSecretSpans(body);
    expect(red.matched).toBe(true);
    expect(red.kinds).toContain("AWS Access Key");
    expect(red.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(red.text).toContain("[redacted-secret:AWS Access Key]");
    // The non-secret content survives — the whole page isn't discarded.
    expect(red.text).toContain("Trends report.");
    expect(red.text).toContain("The end.");
  });

  it("redacts every occurrence, not just the first", () => {
    const body = `a AKIA0000000000000000 b AKIA1111111111111111 c`;
    const red = redactSecretSpans(body);
    expect(red.text).not.toMatch(/AKIA\d/);
    expect(red.text.match(/\[redacted-secret:AWS Access Key\]/g)?.length).toBe(2);
  });

  it("passes benign content through unchanged", () => {
    const body = "Creatine and collagen demand rose in Q2 2026.";
    const red = redactSecretSpans(body);
    expect(red.matched).toBe(false);
    expect(red.text).toBe(body);
  });
});

describe("detectSecretsInOutput — 256KB cap", () => {
  it("does not detect a secret pattern past the 256KB cap", () => {
    const filler = "x".repeat(300_000);
    const input = filler + " AKIA0000000000000000";
    const res = detectSecretsInOutput(input);
    expect(res.matched).toBe(false);
  });

  it("detects a secret pattern within the cap", () => {
    const filler = "x".repeat(100_000);
    const input = filler + " AKIA0000000000000000";
    const res = detectSecretsInOutput(input);
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("AWS Access Key");
  });
});

describe("detectSecretsInOutput — no-leak invariant", () => {
  it("never returns the matched substring (only kind labels)", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const res = detectSecretsInOutput(`some prefix ${secret} some suffix`);
    expect(res.matched).toBe(true);
    // Neither the kinds array nor any string within it should contain the
    // secret. This protects against accidental log leaks.
    for (const k of res.kinds) {
      expect(k).not.toContain(secret);
    }
    expect(JSON.stringify(res)).not.toContain(secret);
  });
});

describe("secret-taint integration", () => {
  it("end-to-end via bash stdout: detection + recordSensitiveRead blocks egress", () => {
    clearSessionTaint("test-end-to-end");
    expect(checkEgressTaint("test-end-to-end").blocked).toBe(false);

    const fakeStdout = "AKIA0000000000000000";
    const det = detectSecretsInOutput(fakeStdout);
    expect(det.matched).toBe(true);
    if (det.matched) {
      recordSensitiveRead("test-end-to-end", "secret", `bash:${det.kinds.join(",")}`);
    }
    expect(checkEgressTaint("test-end-to-end").blocked).toBe(true);
  });

  it("owned-source read still taints when recorded (primitive unchanged)", () => {
    clearSessionTaint("test-owned-e2e");
    expect(checkEgressTaint("test-owned-e2e").blocked).toBe(false);
    // Owned sources (local fs / bash / sql) still taint via the primitive.
    recordSensitiveRead("test-owned-e2e", "secret", "bash:aws-access-key");
    expect(checkEgressTaint("test-owned-e2e").blocked).toBe(true);
  });
});

// Regression test for the taint-race bug: when a tool reads a sensitive
// path the result must NOT contain the raw bytes by the time it lands in
// ctx.result. Without redaction, dataLineageGate only fires on the NEXT
// egress call — meaning the model already has the secret bytes in its
// context and can exfil through any non-gated channel.
describe("run-sandboxed redacts result content when taint fires", () => {
  function makeCtx(input: {
    name: string;
    args: Record<string, unknown>;
    tool: ToolDefinition;
    sessionId: string;
  }): ToolCallContext {
    return {
      tc: { id: "1", name: input.name, arguments: JSON.stringify(input.args) },
      toolMap: new Map(),
      // SecurityLayer is unused by runSandboxedPhase but the type requires it.
      security: undefined as never,
      sessionId: input.sessionId,
      callContext: "local",
      args: input.args,
      tool: input.tool,
      riskLevel: "low",
      approvalContext: "",
      allowed: true,
      msgs: [],
    } as ToolCallContext;
  }

  it("read of a sensitive path: ctx.result.content does not contain the secret bytes", async () => {
    const sentinel = "SENSITIVE_TEST_PAYLOAD_8a3f";
    const dir = mkdtempSync(join(tmpdir(), "lineage-redact-"));
    // secrets.json matches isSensitivePath via /secrets?\.(enc|json|yaml|yml)/i
    const file = join(dir, "secrets.json");
    writeFileSync(file, sentinel, "utf-8");

    const readStub: ToolDefinition = {
      name: "read",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute(args) {
        // Return the file's contents verbatim — what the real read tool
        // would have placed into ctx.result before redaction.
        return { content: `1\t${sentinel}`, isError: false };
      },
    };

    const sessionId = "redact-read-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "read", args: { path: file }, tool: readStub, sessionId });

    try {
      await runSandboxedPhase(ctx);

      expect(ctx.result).toBeDefined();
      // The whole point: the sentinel bytes must NOT reach ctx.result.
      expect(ctx.result!.content).not.toContain(sentinel);
      expect(ctx.result!.status).toBe("blocked");
      expect(ctx.result!.metadata?.redacted).toBe(true);
      // Session is still tainted so a follow-up egress call would be blocked.
      expect(checkEgressTaint(sessionId).blocked).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("benign read: ctx.result passes through unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-redact-"));
    const file = join(dir, "notes.txt");
    writeFileSync(file, "hello world", "utf-8");

    const readStub: ToolDefinition = {
      name: "read",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: "1\thello world", isError: false };
      },
    };

    const sessionId = "redact-benign-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "read", args: { path: file }, tool: readStub, sessionId });

    try {
      await runSandboxedPhase(ctx);
      expect(ctx.result?.content).toContain("hello world");
      expect(ctx.result?.status).not.toBe("blocked");
      expect(checkEgressTaint(sessionId).blocked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // F4 defense-in-depth: confinement (the file-access gate) is the primary
  // control for sql_query, but a secret-shaped value sitting in an in-workspace
  // SQLite row must still taint + redact like web_fetch/http_request output —
  // not pass through untainted. Guards run-sandboxed.ts:85 keeping sql_query in
  // the output scan.
  it("sql_query output containing a secret: result redacted and session tainted", async () => {
    const secret = "AKIA0000000000000000"; // aws-access-key shape
    const sqlStub: ToolDefinition = {
      name: "sql_query",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      // Mirror the wrapExternalContent-wrapped markdown table the real tool returns.
      async execute() {
        return { content: `[external: sql_query]\n| api_key |\n| --- |\n| ${secret} |`, isError: false };
      },
    };
    const sessionId = "redact-sql-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({
      name: "sql_query",
      args: { database: "workspace/app.db", query: "SELECT api_key FROM creds" },
      tool: sqlStub,
      sessionId,
    });

    await runSandboxedPhase(ctx);

    expect(ctx.result).toBeDefined();
    expect(ctx.result!.content).not.toContain(secret);
    expect(ctx.result!.status).toBe("blocked");
    expect(ctx.result!.metadata?.redacted).toBe(true);
    expect(checkEgressTaint(sessionId).blocked).toBe(true);
  });

  // The run-killer fix: a secret-shaped span in UNTRUSTED INBOUND web content
  // must be redacted from the model's view but must NOT discard the whole page
  // or taint the session's egress (a coincidental `sk-…`/AKIA on a trade page
  // previously bricked every downstream tool call for the run).
  it("web_fetch with a secret-shaped span: span redacted inline, page kept, NO taint", async () => {
    const secret = "AKIA0000000000000000";
    const fetchStub: ToolDefinition = {
      name: "web_fetch",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: `Supplement market grew. Ref ${secret}. Collagen up 12%.`, isError: false };
      },
    };
    const sessionId = "web-fetch-inbound";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({
      name: "web_fetch",
      args: { url: "https://example-trade-site.com/report" },
      tool: fetchStub,
      sessionId,
    });

    await runSandboxedPhase(ctx);

    expect(ctx.result).toBeDefined();
    // Secret stripped from the model's view...
    expect(ctx.result!.content).not.toContain(secret);
    expect(ctx.result!.content).toContain("[redacted-secret:AWS Access Key]");
    // ...but the rest of the page survives (not blanket-redacted to a stub)...
    expect(ctx.result!.content).toContain("Collagen up 12%");
    expect(ctx.result!.status).not.toBe("blocked");
    // ...and egress is NOT tainted — downstream search/fetch still work.
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  it("benign web_fetch passes through unchanged", async () => {
    const fetchStub: ToolDefinition = {
      name: "web_fetch",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: "Creatine and collagen demand rose in Q2 2026.", isError: false };
      },
    };
    const sessionId = "web-fetch-benign";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({
      name: "web_fetch",
      args: { url: "https://example.com" },
      tool: fetchStub,
      sessionId,
    });

    await runSandboxedPhase(ctx);
    expect(ctx.result?.content).toContain("Creatine and collagen");
    expect(ctx.result?.status).not.toBe("blocked");
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  it("benign sql_query output passes through unchanged", async () => {
    const sqlStub: ToolDefinition = {
      name: "sql_query",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return { content: `| id | name |\n| --- | --- |\n| 1 | alice |`, isError: false };
      },
    };
    const sessionId = "redact-sql-benign";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({
      name: "sql_query",
      args: { database: "workspace/app.db", query: "SELECT id, name FROM users" },
      tool: sqlStub,
      sessionId,
    });

    await runSandboxedPhase(ctx);
    expect(ctx.result?.content).toContain("alice");
    expect(ctx.result?.status).not.toBe("blocked");
    expect(checkEgressTaint(sessionId).blocked).toBe(false);
  });

  // Capability-class re-keying: sensitive reads via SYNONYMS (ari_file path,
  // email_read / memory_search output) must record the sensitive read (arming
  // the egress gate) AND trigger redaction — exactly like read/sql_query.
  it("ari_file read of a sensitive path: records sensitive read + redacts", async () => {
    const sentinel = "ARI_FILE_SENTINEL_77c2";
    const dir = mkdtempSync(join(tmpdir(), "lineage-arifile-"));
    const file = join(dir, "secrets.json");
    writeFileSync(file, sentinel, "utf-8");
    const stub: ToolDefinition = {
      name: "ari_file",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { return { content: sentinel, isError: false }; },
    };
    const sessionId = "redact-arifile-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "ari_file", args: { action: "read", path: file }, tool: stub, sessionId });
    try {
      await runSandboxedPhase(ctx);
      expect(ctx.result!.content).not.toContain(sentinel);
      expect(ctx.result!.status).toBe("blocked");
      expect(ctx.result!.metadata?.redacted).toBe(true);
      expect(checkEgressTaint(sessionId).blocked).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("email_read output containing a secret: records sensitive read + redacts", async () => {
    const secret = "AKIA0000000000000000";
    const stub: ToolDefinition = {
      name: "email_read",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { return { content: `From: ops\nBody: api key ${secret}`, isError: false }; },
    };
    const sessionId = "redact-emailread-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "email_read", args: { folder: "INBOX" }, tool: stub, sessionId });
    await runSandboxedPhase(ctx);
    expect(ctx.result!.content).not.toContain(secret);
    expect(ctx.result!.status).toBe("blocked");
    expect(checkEgressTaint(sessionId).blocked).toBe(true);
  });

  it("memory_search output containing a secret: records sensitive read + redacts", async () => {
    const secret = "AKIA0000000000000000";
    const stub: ToolDefinition = {
      name: "memory_search",
      description: "test stub",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() { return { content: `recalled: stored token ${secret}`, isError: false }; },
    };
    const sessionId = "redact-memsearch-test";
    clearSessionTaint(sessionId);
    const ctx = makeCtx({ name: "memory_search", args: { query: "token" }, tool: stub, sessionId });
    await runSandboxedPhase(ctx);
    expect(ctx.result!.content).not.toContain(secret);
    expect(ctx.result!.status).toBe("blocked");
    expect(checkEgressTaint(sessionId).blocked).toBe(true);
  });
});

describe("content fingerprints + payload-overlap evidence (T1)", () => {
  const SESS = "fp-session";
  beforeEach(() => clearSessionTaint(SESS));
  afterEach(() => clearSessionTaint(SESS));

  // A chunk of secret content that's long enough to shingle and unlikely to
  // recur in unrelated prose.
  const SECRET_CONTENT =
    "BEGIN PRIVATE BLOB: super-secret-payload-marker-7f3a9c1e-quux-zonk-data END";

  it("a content read carries fingerprints; findTaintInPayload detects a chunk of that exact content", () => {
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa", SECRET_CONTENT);
    // A payload that quotes a CHUNK (not the whole blob) of the tainted content.
    const payload = `Here is some data: super-secret-payload-marker-7f3a9c1e-quux-zonk-data — done.`;
    const hits = findTaintInPayload(SESS, payload);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe("sensitive_file");
    expect(hits[0].target).toBe("/home/u/.ssh/id_rsa");
  });

  it("detects a base64-encoded form of the tainted content (decode-view reuse)", () => {
    recordSensitiveRead(SESS, "secret", "bash:blob", SECRET_CONTENT);
    const b64 = Buffer.from(SECRET_CONTENT, "utf-8").toString("base64");
    const payload = `exfil attempt blob=${b64} trailing`;
    const hits = findTaintInPayload(SESS, payload);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].target).toBe("bash:blob");
  });

  it("NEGATIVE: a payload with none of the tainted content returns []", () => {
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa", SECRET_CONTENT);
    const payload = "Completely unrelated quarterly sales prose about collagen and creatine demand.";
    expect(findTaintInPayload(SESS, payload)).toEqual([]);
  });

  it("NEGATIVE: a 3-arg read (no content) produces no fingerprint evidence", () => {
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa");
    // Even a payload echoing the target path yields no fingerprint hit (no content recorded).
    expect(findTaintInPayload(SESS, "/home/u/.ssh/id_rsa contents here")).toEqual([]);
  });

  it("checkEgressTaint still blocks a tainted session (presence floor unchanged)", () => {
    // No content at all → presence floor must still block.
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa");
    expect(checkEgressTaint(SESS).blocked).toBe(true);
  });

  it("checkEgressTaintWithPayload blocks on presence even when payload carries NO tainted bytes; evidence []", () => {
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa", SECRET_CONTENT);
    const res = checkEgressTaintWithPayload(SESS, "totally benign outbound text");
    // Presence-based floor: still blocked.
    expect(res.blocked).toBe(true);
    // But no content overlap → no evidence sources named.
    expect(res.evidence).toEqual([]);
  });

  it("checkEgressTaintWithPayload names the source when the payload carries tainted bytes", () => {
    recordSensitiveRead(SESS, "sensitive_file", "/home/u/.ssh/id_rsa", SECRET_CONTENT);
    const payload = `POST body: super-secret-payload-marker-7f3a9c1e-quux-zonk-data`;
    const res = checkEgressTaintWithPayload(SESS, payload);
    expect(res.blocked).toBe(true);
    expect(res.evidence.length).toBeGreaterThan(0);
    expect(res.reason).toMatch(/payload contains bytes|id_rsa|sensitive_file/i);
  });

  it("a clean session never blocks regardless of payload content", () => {
    const res = checkEgressTaintWithPayload(SESS, "anything at all");
    expect(res.blocked).toBe(false);
    expect(res.evidence).toEqual([]);
  });

  it("no plaintext content is stored on the taint entry (fingerprints are hashes)", () => {
    recordSensitiveRead(SESS, "secret", "bash:blob", SECRET_CONTENT);
    // The overlap primitive works, proving fingerprints exist — but a serialized
    // view of the session's evidence path must never echo the plaintext content.
    const res = checkEgressTaintWithPayload(SESS, "benign");
    expect(JSON.stringify(res)).not.toContain("super-secret-payload-marker");
    // findTaintInPayload returns provenance only, never content.
    const hits = findTaintInPayload(SESS, SECRET_CONTENT);
    expect(JSON.stringify(hits)).not.toContain("super-secret-payload-marker");
  });
});

describe("getKernelTaintSources — LAX → kernel taint mapping", () => {
  it("returns [] for a clean session", () => {
    clearSessionTaint("clean-1");
    expect(getKernelTaintSources("clean-1")).toEqual([]);
  });

  it("maps web → web, memory → rag, sensitive_file/secret → rag, user_data → user-provided", () => {
    const sid = "map-1";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "http://x");
    recordSensitiveRead(sid, "memory", "note");
    recordSensitiveRead(sid, "sensitive_file", "/Users/x/.aws/credentials");
    recordSensitiveRead(sid, "secret", "bash:openai-key");
    recordSensitiveRead(sid, "user_data", "form-input");
    const sources = getKernelTaintSources(sid).sort();
    // web/memory/sensitive_file/secret all land in the kernel deny-set
    // (web/rag); user_data maps to user-provided (intentionally NOT denied).
    expect(sources).toEqual(["rag", "user-provided", "web"]);
    clearSessionTaint(sid);
  });

  it("web/rag sources are the ones the kernel deny-tainted-shell rule keys on", () => {
    const sid = "map-2";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "http://x");
    expect(getKernelTaintSources(sid)).toContain("web");
    clearSessionTaint(sid);
  });
});

describe("propagateTaint — parent ← child sub-agent propagation", () => {
  it("carries a child's sensitive read into the parent session", () => {
    const child = "agent-abc123";
    const parent = "chat-parent-1";
    clearSessionTaint(child);
    clearSessionTaint(parent);

    // Parent starts clean.
    expect(checkEgressTaint(parent).blocked).toBe(false);
    expect(getKernelTaintSources(parent)).toEqual([]);

    // Child reads a sensitive file.
    recordSensitiveRead(child, "sensitive_file", "/Users/x/.ssh/id_rsa");

    // Propagation (as fired at sub-agent completion) taints the parent.
    const moved = propagateTaint(child, parent);
    expect(moved).toBe(1);
    expect(checkEgressTaint(parent).blocked).toBe(true);
    // And the parent now hands the kernel non-empty taint on its next gated call.
    expect(getKernelTaintSources(parent)).toContain("rag");

    clearSessionTaint(child);
    clearSessionTaint(parent);
  });

  it("is a no-op when the child is clean", () => {
    const child = "agent-clean";
    const parent = "chat-parent-2";
    clearSessionTaint(child);
    clearSessionTaint(parent);
    expect(propagateTaint(child, parent)).toBe(0);
    expect(checkEgressTaint(parent).blocked).toBe(false);
  });

  it("does not propagate a session into itself", () => {
    const sid = "agent-self";
    clearSessionTaint(sid);
    recordSensitiveRead(sid, "web", "http://x");
    expect(propagateTaint(sid, sid)).toBe(0);
    clearSessionTaint(sid);
  });
});

// Regression for finding H4 (HIGH): a sub-agent's tool calls record taint under
// `req.sessionId ?? agent-<id>` (handler-events.ts: runSessionId). The Handler's
// completion path (pushCompletionToParent) must propagate FROM that SAME bucket.
// Before the fix it re-derived `agent-<id>` unconditionally, so an
// operations-executor phase spawned with a BORROWED sessionId (`agent-op-<id>`)
// recorded taint under the borrowed id while propagation read an EMPTY
// `agent-<id>` map — orphaning the taint and leaving the parent CLEAN.
//
// We drive the real seam: attachExternalRun (storing the borrowed runSessionId) →
// record taint under that bucket → finalizeExternalRun (fires
// pushCompletionToParent) → assert the parent is now tainted.
describe("Handler completion → taint propagation from the child's ACTUAL session (H4)", () => {
  afterEach(() => {
    Handler.resetInstance();
  });

  it("propagates from a BORROWED sessionId (ops-phase) the child's tools recorded under", () => {
    const handler = Handler.getInstance();
    const parent = "chat-parent-h4-borrowed";
    const borrowed = "agent-op-OP123"; // what operations/executor passes as opts.sessionId
    clearSessionTaint(parent);
    clearSessionTaint(borrowed);

    // Spawn a phase agent the way invokeDefinition does: parent linkage + the
    // borrowed runtime session it will record taint under.
    const { agentId } = handler.attachExternalRun({
      name: "op-phase",
      role: "operator",
      task: "do a phase",
      parentSessionId: parent,
      runSessionId: borrowed,
    });
    clearSessionTaint(`agent-${agentId}`); // ensure the re-derived bucket is empty

    // Parent starts clean.
    expect(checkEgressTaint(parent).blocked).toBe(false);

    // The phase's tools read a sensitive file — recorded under the BORROWED id.
    recordSensitiveRead(borrowed, "sensitive_file", "/Users/x/.ssh/id_rsa", "ssh private key bytes here");

    // Completion fires pushCompletionToParent. Pre-fix this copied nothing
    // (read the empty `agent-<id>` bucket) and the parent stayed CLEAN.
    handler.finalizeExternalRun(agentId, { result: "phase done", success: true });

    expect(checkEgressTaint(parent).blocked).toBe(true);
    expect(getKernelTaintSources(parent)).toContain("rag");

    clearSessionTaint(parent);
    clearSessionTaint(borrowed);
  });

  it("still propagates in the DEFAULT case (no borrowed sessionId → agent-<id>)", () => {
    const handler = Handler.getInstance();
    const parent = "chat-parent-h4-default";
    clearSessionTaint(parent);

    // No runSessionId — the run uses its auto-minted `agent-<id>` tool session.
    const { agentId } = handler.attachExternalRun({
      name: "spawned",
      role: "researcher",
      task: "research",
      parentSessionId: parent,
    });
    const auto = `agent-${agentId}`;
    clearSessionTaint(auto);

    expect(checkEgressTaint(parent).blocked).toBe(false);

    // Child records taint under the default `agent-<id>` bucket.
    recordSensitiveRead(auto, "web", "https://internal.example/secret");

    handler.finalizeExternalRun(agentId, { result: "done", success: true });

    expect(checkEgressTaint(parent).blocked).toBe(true);
    expect(getKernelTaintSources(parent)).toContain("web");

    clearSessionTaint(parent);
    clearSessionTaint(auto);
  });
});

describe("declassification — deliberate, audited untaint (T2)", () => {
  // Each test points the declassify audit trail at a fresh temp dir so the
  // emitted event can be read back from the daily JSONL and the chain verified,
  // without touching the real ~/.lax audit log.
  let auditDir: string;

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), "lax-declassify-"));
    _setDeclassifyAuditTrail(new CryptoAuditTrail(auditDir));
  });

  afterEach(() => {
    _setDeclassifyAuditTrail(null);
    rmSync(auditDir, { recursive: true, force: true });
  });

  // Read the single daily audit file the temp trail wrote (parse JSONL → rows).
  function auditEntries(): Array<Record<string, unknown>> {
    const dir = join(auditDir, "audit");
    const files = readdirSync(dir).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"));
    expect(files).toHaveLength(1);
    const path = join(dir, files[0]);
    return readFileSync(path, "utf-8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>);
  }
  function auditPath(): string {
    const dir = join(auditDir, "audit");
    return join(dir, readdirSync(dir).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"))[0]);
  }

  const SECRET_CONTENT = "BEGIN PRIVATE BLOB: super-secret-payload-marker-7f3a9c1e-quux-zonk END";

  it("declassifySession turns the egress gate from blocked → not-blocked", () => {
    const sid = "declass-1";
    recordSensitiveRead(sid, "sensitive_file", "/home/u/.ssh/id_rsa");
    expect(checkEgressTaint(sid).blocked).toBe(true);

    const res = declassifySession(sid, { reason: "user approved one-time export", authorizedBy: "operator" });
    expect(res.cleared).toBe(1);
    expect(res.sources).toEqual([{ source: "sensitive_file", target: "/home/u/.ssh/id_rsa" }]);

    // Only AFTER the explicit declassify does the gate stop blocking.
    expect(checkEgressTaint(sid).blocked).toBe(false);
  });

  it("appends a verifiable audit event with reason + authorizedBy and NO fingerprinted content", () => {
    const sid = "declass-2";
    recordSensitiveRead(sid, "secret", "bash:blob", SECRET_CONTENT);
    declassifySession(sid, { reason: "released after manual review", authorizedBy: "alice@op" });

    const entries = auditEntries();
    const declass = entries.find(e => e.event === "taint_declassified");
    expect(declass).toBeDefined();
    expect(declass!.sessionId).toBe(sid);
    expect(String(declass!.reason)).toContain("released after manual review");
    expect(String(declass!.reason)).toContain("authorizedBy=alice@op");
    expect(declass!.role).toBe("alice@op");
    // Cleared source NAME is present; fingerprinted CONTENT never is.
    expect(String(declass!.reason)).toContain("secret:bash:blob");
    expect(JSON.stringify(declass)).not.toContain("super-secret-payload-marker");

    // The event landed on the tamper-evident chain and verifies.
    expect(CryptoAuditTrail.verify(auditPath()).valid).toBe(true);
  });

  it("declassifyTaintSource clears only the named source; other-source taint still blocks", () => {
    const sid = "declass-3";
    recordSensitiveRead(sid, "web", "http://evil.test");
    recordSensitiveRead(sid, "secret", "bash:openai-key");
    expect(checkEgressTaint(sid).blocked).toBe(true);

    // Release web-derived taint only.
    const res = declassifyTaintSource(sid, "web", { reason: "web page was benign", authorizedBy: "user" });
    expect(res.cleared).toBe(1);
    expect(res.sources).toEqual([{ source: "web", target: "http://evil.test" }]);

    // Secret-derived taint remains → egress STILL blocked.
    expect(checkEgressTaint(sid).blocked).toBe(true);
    expect(getKernelTaintSources(sid)).toEqual(["rag"]);

    // Now release the secret too → clean.
    declassifyTaintSource(sid, "secret", { reason: "secret rotated", authorizedBy: "user" });
    expect(checkEgressTaint(sid).blocked).toBe(false);
  });

  it("the silent clearSessionTaint path still works and writes NO audit event", () => {
    const sid = "declass-4";
    recordSensitiveRead(sid, "sensitive_file", "/home/u/.ssh/id_rsa");
    expect(checkEgressTaint(sid).blocked).toBe(true);

    clearSessionTaint(sid);
    expect(checkEgressTaint(sid).blocked).toBe(false);

    // New-chat reset is NOT a declassification — the audit trail stays empty.
    const dir = join(auditDir, "audit");
    expect(readdirSync(dir).filter(f => f.endsWith(".jsonl") && !f.endsWith(".anchors.jsonl"))).toHaveLength(0);
  });

  it("nothing automatic untaints: checkEgressTaint alone never clears the session", () => {
    const sid = "declass-5";
    recordSensitiveRead(sid, "sensitive_file", "/home/u/.ssh/id_rsa", SECRET_CONTENT);
    // Repeated gate checks (incl. payload-aware) must not mutate taint state.
    for (let i = 0; i < 5; i++) {
      expect(checkEgressTaint(sid).blocked).toBe(true);
      expect(checkEgressTaintWithPayload(sid, "benign outbound").blocked).toBe(true);
    }
    // Still blocked until an EXPLICIT declassify clears it.
    expect(checkEgressTaint(sid).blocked).toBe(true);
    declassifySession(sid, { reason: "explicit release", authorizedBy: "operator" });
    expect(checkEgressTaint(sid).blocked).toBe(false);
  });

  it("declassifying an already-clean session still records the deliberate release", () => {
    const sid = "declass-6";
    const res = declassifySession(sid, { reason: "precautionary clear", authorizedBy: "operator" });
    expect(res.cleared).toBe(0);
    expect(res.sources).toEqual([]);
    // The deliberate action is itself on the record even with nothing to clear.
    const declass = auditEntries().find(e => e.event === "taint_declassified");
    expect(declass).toBeDefined();
    expect(String(declass!.reason)).toContain("(none)");
  });
});

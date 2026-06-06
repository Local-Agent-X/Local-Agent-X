import { describe, it, expect, beforeEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractSensitivePathsFromCommand,
  recordSensitiveRead,
  checkEgressTaint,
  clearSessionTaint,
  isSensitivePath,
  detectSecretsInOutput,
  redactSecretSpans,
} from "./data-lineage.js";
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

describe("detectSecretsInOutput — positive cases", () => {
  it("matches OpenAI-style API key", () => {
    const res = detectSecretsInOutput("sk-abc123xyz456789012345");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("openai-key");
  });

  it("matches Anthropic-style API key", () => {
    const secret = "sk-ant-" + "deadbeef" + "a".repeat(30);
    const res = detectSecretsInOutput(secret);
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("anthropic-key");
  });

  it("matches AWS access key ID", () => {
    const res = detectSecretsInOutput("AKIAIOSFODNN7EXAMPLE");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("aws-access-key");
  });

  it("matches AWS secret access key when keyword anchors the line", () => {
    const res = detectSecretsInOutput("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("aws-secret");
  });

  it("matches GitHub PAT (ghp_ form)", () => {
    const res = detectSecretsInOutput("ghp_" + "a".repeat(36));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("github-pat");
  });

  it("matches Slack bot token", () => {
    const res = detectSecretsInOutput("xoxb-1234567890-abcdef123456");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("slack-token");
  });

  it("matches Google API key", () => {
    const res = detectSecretsInOutput("AIza" + "a".repeat(35));
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("google-key");
  });

  it("matches JWT-shaped string", () => {
    const seg = "a".repeat(20);
    const jwt = `eyJ${seg}.eyJ${seg}.${seg}`;
    const res = detectSecretsInOutput(jwt);
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("jwt");
  });

  it("matches private key block markers", () => {
    const res = detectSecretsInOutput("-----BEGIN RSA PRIVATE KEY-----");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("private-key-block");
  });

  it("matches keyword-near-value heuristic", () => {
    const res = detectSecretsInOutput("password: abcdef1234567890ABCDE");
    expect(res.matched).toBe(true);
    expect(res.kinds).toContain("keyword-near-value");
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
    expect(res.kinds).toContain("openai-key");
  });

  it("still matches a project-scoped key shape", () => {
    const res = detectSecretsInOutput("sk-proj-" + "Ab12".repeat(8));
    expect(res.kinds).toContain("openai-key");
  });
});

describe("redactSecretSpans — surgical inline redaction for untrusted inbound content", () => {
  it("replaces the secret span with a marker and keeps surrounding text", () => {
    const body = "Trends report. Contact AKIAIOSFODNN7EXAMPLE for access. The end.";
    const red = redactSecretSpans(body);
    expect(red.matched).toBe(true);
    expect(red.kinds).toContain("aws-access-key");
    expect(red.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(red.text).toContain("[redacted-secret:aws-access-key]");
    // The non-secret content survives — the whole page isn't discarded.
    expect(red.text).toContain("Trends report.");
    expect(red.text).toContain("The end.");
  });

  it("redacts every occurrence, not just the first", () => {
    const body = `a AKIA0000000000000000 b AKIA1111111111111111 c`;
    const red = redactSecretSpans(body);
    expect(red.text).not.toMatch(/AKIA\d/);
    expect(red.text.match(/\[redacted-secret:aws-access-key\]/g)?.length).toBe(2);
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
    expect(res.kinds).toContain("aws-access-key");
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
    expect(ctx.result!.content).toContain("[redacted-secret:aws-access-key]");
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
});

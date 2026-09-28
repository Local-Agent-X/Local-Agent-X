import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  sensitivePathsReadByCommand,
  recordSensitiveRead,
  checkEgressTaint,
  clearSessionTaint,
  isSensitivePath,
  isSensitiveAttachmentPath,
  getKernelTaintSources,
  propagateTaint,
} from "./index.js";

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
    // -- C3-10 coverage: credential stores the old set missed --
    ["/Users/x/.git-credentials", true, "plaintext git https creds"],
    ["/Users/x/.config/gcloud/application_default_credentials.json", true, "gcloud ADC"],
    ["/Users/x/.config/gcloud/legacy_credentials/me@x.com/adc.json", true, "gcloud legacy ADC, mid-path dir (dead-rule fix)"],
    ["/Users/x/.config/rclone/rclone.conf", true, "rclone remote tokens"],
    ["/Users/x/.config/sops/age/keys.txt", true, "sops age private keys"],
    ["/Users/x/.databrickscfg", true, "databricks host+PAT"],
    ["/Users/x/.pgpass", true, "postgres password file"],
    ["/Users/x/.my.cnf", true, "mysql client password"],
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
    // -- R4-04/R4-05: the app's OWN at-rest key/seed/vault files (was a drift) --
    ["/Users/x/.lax/audit-key", true, "audit HMAC seed (legacy plaintext) — was read-untainted"],
    ["/Users/x/.lax/audit-key.enc", true, "sealed audit seed — .enc was attachment-only before"],
    ["/Users/x/.lax/secrets.salt", true, "file-fallback key salt — was not in SENSITIVE_BASENAMES"],
    ["/Users/x/.lax/secrets.enc", true, "encrypted secrets vault"],
    ["/Users/x/.lax/master.dpapi", true, "DPAPI-sealed master key"],
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

    // -- Content subdirs of the LAX data dir are USER content meant to be sent
    //    off-box (a photo attached from a paired device, agent-generated media).
    //    Blocking them bricked generate_video-from-a-photo + WhatsApp/Telegram
    //    image sends. The rest of the data dir stays sensitive. --
    [join(home, ".lax", "uploads", "att-a6b8be1adae4.jpeg"), false, "a photo the user attached from mobile"],
    ["~/.lax/uploads/photo.png", false, "upload, leading ~"],
    [join(home, ".lax", "workspace", "images", "generated.png"), false, "agent-generated image, sendable"],
    [join(home, ".lax", "config.json"), true, "holds the authToken — still sensitive"],
    [join(home, ".lax", "memory", "profile.md"), true, "personal memory — not for off-box attach"],

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
describe("sensitivePathsReadByCommand", () => {
  it("matches POSIX absolute paths to ssh keys", () => {
    const matches = sensitivePathsReadByCommand("cat /home/user/.ssh/id_rsa");
    expect(matches).toContain("/home/user/.ssh/id_rsa");
  });

  it("matches tilde-expanded paths", () => {
    const matches = sensitivePathsReadByCommand("cat ~/.ssh/id_rsa");
    // We return the raw token (post-quote-strip, pre-tilde-expansion),
    // but the resolved form must be what isSensitivePath flagged.
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]).toMatch(/\.ssh/);
    // Sanity: confirm the resolution path matches a sensitive pattern.
    const resolved = matches[0].replace(/^~/, homedir());
    expect(isSensitivePath(resolved)).toBe(true);
  });

  it("matches Windows absolute paths", () => {
    const matches = sensitivePathsReadByCommand("type C:\\Users\\me\\.aws\\credentials");
    expect(matches).toContain("C:\\Users\\me\\.aws\\credentials");
  });

  it("taints a read of the app's OWN audit seed (R4-04 drift fix)", () => {
    // `cat ~/.lax/audit-key` was previously read-untainted because audit-key
    // wasn't in the sensitivity enumeration. It must now be extracted as a
    // sensitive path so the read taints the session.
    const matches = sensitivePathsReadByCommand("cat ~/.lax/audit-key");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]).toMatch(/audit-key/);
    expect(isSensitivePath(matches[0].replace(/^~/, homedir()))).toBe(true);
  });

  it("strips surrounding quotes", () => {
    const matches = sensitivePathsReadByCommand(`cat "/Users/x/.aws/credentials"`);
    expect(matches).toContain("/Users/x/.aws/credentials");
  });

  it("matches single-quoted paths", () => {
    const matches = sensitivePathsReadByCommand(`cat '/Users/x/.aws/credentials'`);
    expect(matches).toContain("/Users/x/.aws/credentials");
  });

  it("returns multiple matches", () => {
    const matches = sensitivePathsReadByCommand("cat ~/.ssh/id_rsa ~/.aws/credentials");
    expect(matches.length).toBe(2);
    expect(matches.some(p => p.includes(".ssh"))).toBe(true);
    expect(matches.some(p => p.includes(".aws"))).toBe(true);
  });

  it("does not false-positive on benign commands", () => {
    expect(sensitivePathsReadByCommand("ls -la")).toEqual([]);
    expect(sensitivePathsReadByCommand("git status")).toEqual([]);
    expect(sensitivePathsReadByCommand("echo /something/regular.txt")).toEqual([]);
  });

  it("dedupes repeated paths", () => {
    const matches = sensitivePathsReadByCommand("cat ~/.ssh/id_rsa && cp ~/.ssh/id_rsa /tmp/x");
    const tildeHits = matches.filter(p => p === "~/.ssh/id_rsa");
    expect(tildeHits.length).toBe(1);
  });

  it("handles empty and whitespace input", () => {
    expect(sensitivePathsReadByCommand("")).toEqual([]);
    expect(sensitivePathsReadByCommand("   ")).toEqual([]);
  });

  it("splits on pipes and redirects", () => {
    const matches = sensitivePathsReadByCommand("cat ~/.ssh/id_rsa | base64");
    expect(matches.some(p => p.includes(".ssh"))).toBe(true);
  });

  it("flags .pem and .key suffixes", () => {
    const matches = sensitivePathsReadByCommand("openssl rsa -in /etc/ssl/private/server.key");
    expect(matches).toContain("/etc/ssl/private/server.key");
  });

  // A path that is only NAMED is not read: the operand of a query command,
  // or a redirect's write target. 2026-09-28: `git check-ignore -v .env
  // supabase/.env apps/web/.env` withheld a whole three-command output.
  it("does not count a named path as a read", () => {
    const real = `cd "/c/Users/peter/Scan Progress" && sed -n '105p' apps/web/src/components/customers/MealPlanBuilder.test.tsx | sed -E 's/[A-Za-z0-9+\\/_-]{20,}/<LONG>/g'; sed -n '8,9p' deno.lock | sed -E 's/[A-Za-z0-9+\\/_-]{20,}/<LONG>/g'; git check-ignore -v .env .env.local supabase/.env apps/web/.env 2>&1 | head`;
    expect(sensitivePathsReadByCommand(real)).toEqual([]);
    for (const cmd of [
      "git ls-files supabase/.env apps/web/.env",
      "git add apps/web/.env.example supabase/.env",
      "ls -la ~/.ssh/id_rsa ~/.aws/credentials",
      "test -f ~/.aws/credentials && echo present",
      "stat /home/u/.env",
      "grep -l SECRET /home/u/.env /home/u/.env.local",
      "grep -c = ~/.aws/credentials",
      "wc -l /home/u/.env",
      "echo 'wrote' > /home/u/.env",
      "printf 'X=1\\n' >> ~/.aws/credentials",
      "rm /home/u/.env",
    ]) {
      expect(sensitivePathsReadByCommand(cmd), cmd).toEqual([]);
    }
  });

  it("counts a read wherever the command actually consumes the bytes", () => {
    for (const [cmd, path] of [
      ["grep SECRET /home/u/.env", "/home/u/.env"],
      ["git diff -- /home/u/.env", "/home/u/.env"],
      ["git show HEAD:/home/u/.env", "HEAD:/home/u/.env"],
      ["sort < /home/u/.env", "/home/u/.env"],
      ["sort </home/u/.env", "/home/u/.env"],
      ["bash -c 'cat ~/.ssh/id_rsa'", "~/.ssh/id_rsa"],
      ["(cat ~/.ssh/id_rsa)", "~/.ssh/id_rsa"],
      ["python3 leak.py /home/u/.env", "/home/u/.env"],
      ["cp ~/.aws/credentials /tmp/x", "~/.aws/credentials"],
    ] as const) {
      expect(sensitivePathsReadByCommand(cmd), cmd).toEqual([path]);
    }
  });
});

describe("bash taint integration", () => {
  beforeEach(() => clearSessionTaint("test-session"));

  it("taints the session via bash command containing sensitive path", () => {
    expect(checkEgressTaint("test-session").blocked).toBe(false);

    // Mirror what run-sandboxed.ts now does for the bash branch.
    const cmd = "cat ~/.ssh/id_rsa";
    const matches = sensitivePathsReadByCommand(cmd);
    expect(matches.length).toBeGreaterThan(0);
    for (const p of matches) {
      recordSensitiveRead("test-session", "sensitive_file", p);
    }

    const egress = checkEgressTaint("test-session");
    expect(egress.blocked).toBe(true);
    expect(egress.reason).toMatch(/id_rsa|\.ssh/);
  });

  it("does not taint on benign bash commands", () => {
    const matches = sensitivePathsReadByCommand("ls -la && git status");
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

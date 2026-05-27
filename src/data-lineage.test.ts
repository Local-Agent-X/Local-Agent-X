import { describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import {
  extractSensitivePathsFromCommand,
  recordSensitiveRead,
  checkEgressTaint,
  clearSessionTaint,
  isSensitivePath,
} from "./data-lineage.js";

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

import { describe, it, expect } from "vitest";
import { matchArgPattern, matchGlob, matchHost } from "../src/tool-policy/matchers.js";

describe("matchGlob — tool name matching", () => {
  it("'*' matches any tool", () => {
    expect(matchGlob("*", "anything")).toBe(true);
  });

  it("exact match wins", () => {
    expect(matchGlob("bash", "bash")).toBe(true);
    expect(matchGlob("bash", "write")).toBe(false);
  });

  it("'http_*' matches names starting with 'http_'", () => {
    expect(matchGlob("http_*", "http_request")).toBe(true);
    expect(matchGlob("http_*", "http_fetch")).toBe(true);
    expect(matchGlob("http_*", "https")).toBe(false);
  });

  // Latent bug: the fallback `pattern.includes(".*")` branch is unreachable when
  // the pattern ends with "*", because endsWith("*") wins first and slice(0,-1)
  // for "browser.*" produces "browser." — `"browser".startsWith("browser.")` is
  // false. So matchGlob("browser.*", "browser") returns false despite the source
  // comment claiming otherwise. Pinning current behavior; not fixing here.
  it("'browser.*' does NOT match 'browser' (latent bug — see source comment)", () => {
    expect(matchGlob("browser.*", "browser")).toBe(false);
  });

  it("non-glob non-match returns false", () => {
    expect(matchGlob("bash", "browser")).toBe(false);
  });
});

describe("matchArgPattern — glob arg value matching", () => {
  it("'*' matches anything", () => {
    expect(matchArgPattern("*", "")).toBe(true);
    expect(matchArgPattern("*", "anything")).toBe(true);
  });

  it("exact string match", () => {
    expect(matchArgPattern("git", "git")).toBe(true);
    expect(matchArgPattern("git", "go")).toBe(false);
  });

  it("'git *' matches commands starting with 'git '", () => {
    expect(matchArgPattern("git *", "git status")).toBe(true);
    expect(matchArgPattern("git *", "git push origin main")).toBe(true);
    expect(matchArgPattern("git *", "good idea")).toBe(false);
  });

  it("'workspace/*' matches paths under workspace", () => {
    expect(matchArgPattern("workspace/*", "workspace/file.txt")).toBe(true);
    expect(matchArgPattern("workspace/*", "src/file.txt")).toBe(false);
  });

  it("'*.ts' matches .ts files", () => {
    expect(matchArgPattern("*.ts", "index.ts")).toBe(true);
    expect(matchArgPattern("*.ts", "index.js")).toBe(false);
  });

  it("escapes special regex chars in the pattern (no ReDoS, no false positives)", () => {
    // '.' should match literal dot, not "any char"
    expect(matchArgPattern("a.b", "a.b")).toBe(true);
    expect(matchArgPattern("a.b", "axb")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchArgPattern("git *", "GIT status")).toBe(true);
  });

  it("'rm -rf *' matches the destructive bash pattern", () => {
    expect(matchArgPattern("rm -rf *", "rm -rf /")).toBe(true);
    expect(matchArgPattern("rm -rf *", "rm -rf /home/user/temp")).toBe(true);
    expect(matchArgPattern("rm -rf *", "rmdir foo")).toBe(false);
  });
});

describe("matchHost", () => {
  it("matches exact host", () => {
    expect(matchHost(["api.example.com"], "api.example.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchHost(["API.EXAMPLE.COM"], "api.example.com")).toBe(true);
    expect(matchHost(["api.example.com"], "API.EXAMPLE.COM")).toBe(true);
  });

  it("'*.example.com' matches any subdomain", () => {
    expect(matchHost(["*.example.com"], "api.example.com")).toBe(true);
    expect(matchHost(["*.example.com"], "deep.api.example.com")).toBe(true);
  });

  it("'*.example.com' does NOT match a sibling domain", () => {
    expect(matchHost(["*.example.com"], "evil.com")).toBe(false);
    expect(matchHost(["*.example.com"], "example.com.evil.com")).toBe(false);
  });

  it("returns false when no patterns match", () => {
    expect(matchHost(["api.example.com"], "other.com")).toBe(false);
  });

  it("returns false on empty pattern list", () => {
    expect(matchHost([], "api.example.com")).toBe(false);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import {
  wrapDirectOAuthToken, isDirectOAuthToken, unwrapDirectOAuthToken,
  toOAuthWireName, fromOAuthWireName, buildOAuthHeaders, CLAUDE_CODE_SYSTEM_PREFIX,
  adoptRequiredClaudeCodeVersion, claudeCodeUserAgent, resetClaudeCodeVersionForTest,
} from "./oauth-direct.js";

describe("oauth-direct token wrapper", () => {
  it("round-trips wrap → unwrap and detects the shape", () => {
    const raw = "sk-ant-oat-abc123";
    const wrapped = wrapDirectOAuthToken(raw);
    expect(isDirectOAuthToken(wrapped)).toBe(true);
    expect(unwrapDirectOAuthToken(wrapped)).toBe(raw);
  });

  it("does not misclassify a plain token or an x-api-key", () => {
    expect(isDirectOAuthToken("cli")).toBe(false);
    expect(isDirectOAuthToken("sk-ant-api03-real")).toBe(false);
    expect(isDirectOAuthToken("oauth:tok")).toBe(false);
    // unwrap is a no-op on an unwrapped token
    expect(unwrapDirectOAuthToken("sk-ant-api03-real")).toBe("sk-ant-api03-real");
  });
});

describe("toOAuthWireName — billing-classifier normalization", () => {
  it("leaves bare LAX-native tool names UNCHANGED (they bill fine and must stay recognizable)", () => {
    expect(toOAuthWireName("read_file")).toBe("read_file");
    expect(toOAuthWireName("build_app")).toBe("build_app");
  });
  it("promotes a single-underscore mcp_ name to double underscore (the actual billing-lane fingerprint)", () => {
    expect(toOAuthWireName("mcp_linear_get_issue")).toBe("mcp__linear_get_issue");
  });
  it("leaves an already-correct mcp__ name untouched (no double prefix)", () => {
    expect(toOAuthWireName("mcp__foo")).toBe("mcp__foo");
  });
  it("renames the memory_search/memory_get fingerprint pair to break the extra-usage match", () => {
    expect(toOAuthWireName("memory_search")).toBe("lax_memory_search");
    expect(toOAuthWireName("memory_get")).toBe("lax_memory_get");
    // A different memory tool that isn't part of the fingerprint stays bare.
    expect(toOAuthWireName("memory_write")).toBe("memory_write");
  });
});

describe("fromOAuthWireName — reverse to LAX name", () => {
  it("prefers the explicit wire→original map (mcp_ → mcp__ promotions)", () => {
    const map = new Map([["mcp__linear_get_issue", "mcp_linear_get_issue"]]);
    expect(fromOAuthWireName("mcp__linear_get_issue", map)).toBe("mcp_linear_get_issue");
  });
  it("passes a bare native name through untouched (never renamed, never in the map)", () => {
    expect(fromOAuthWireName("build_app", new Map())).toBe("build_app");
  });
  it("reverses a fingerprint-renamed tool via the map", () => {
    const wire = toOAuthWireName("memory_search"); // → lax_memory_search
    const map = new Map([[wire, "memory_search"]]);
    expect(fromOAuthWireName(wire, map)).toBe("memory_search");
  });
  it("strips the lax_ prefix for a fingerprint tool absent from the map (history replay)", () => {
    expect(fromOAuthWireName("lax_memory_get", new Map())).toBe("memory_get");
    // But does NOT strip lax_ from an unrelated name that merely starts with it.
    expect(fromOAuthWireName("lax_something_else", new Map())).toBe("lax_something_else");
  });
  it("falls back to stripping mcp__ for a promoted name absent from the map", () => {
    expect(fromOAuthWireName("mcp__web_search", new Map())).toBe("web_search");
  });
  it("is the inverse of toOAuthWireName for an mcp_ name via the map", () => {
    const original = "mcp_srv_tool";
    const wire = toOAuthWireName(original); // → mcp__srv_tool
    const map = new Map([[wire, original]]);
    expect(fromOAuthWireName(wire, map)).toBe(original);
  });
});

describe("buildOAuthHeaders", () => {
  it("uses Bearer auth (not x-api-key) and Claude Code identity", () => {
    const h = buildOAuthHeaders("tok-xyz");
    expect(h.authorization).toBe("Bearer tok-xyz");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["x-app"]).toBe("cli");
    expect(h["user-agent"]).toMatch(/^claude-code\/\d/);
    // The routing-critical betas must be present.
    expect(h["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(h["anthropic-beta"]).toContain("claude-code-20250219");
  });
});

describe("system prefix", () => {
  it("is the exact string the OAuth router keys on", () => {
    expect(CLAUDE_CODE_SYSTEM_PREFIX).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });
});

describe("adoptRequiredClaudeCodeVersion — the claude-code version floor", () => {
  const floorError = (current: string, required: string) => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `Claude Code ${current} does not support this model; version ${required} or newer is required. Run 'claude update', or update the Claude desktop app, then try again.` } });

  afterEach(() => resetClaudeCodeVersionForTest());

  it("sends a floor that clears Opus 5.5 with no CLI installed", () => {
    expect(claudeCodeUserAgent()).toBe("claude-code/2.1.280 (external, cli)");
  });

  it("adopts a newer required version from the real 400 text and puts it on the wire", () => {
    expect(adoptRequiredClaudeCodeVersion(floorError("2.1.280", "2.1.300"))).toBe(true);
    expect(buildOAuthHeaders("tok")["user-agent"]).toBe("claude-code/2.1.300 (external, cli)");
  });

  it("compares numerically, not lexically (2.1.1000 > 2.1.999)", () => {
    expect(adoptRequiredClaudeCodeVersion(floorError("2.1.280", "2.1.999"))).toBe(true);
    expect(adoptRequiredClaudeCodeVersion(floorError("2.1.999", "2.1.1000"))).toBe(true);
    expect(claudeCodeUserAgent()).toContain("2.1.1000");
  });

  it("refuses a floor we already meet, so a persisting rejection cannot loop", () => {
    expect(adoptRequiredClaudeCodeVersion(floorError("2.1.280", "2.1.280"))).toBe(false);
    expect(adoptRequiredClaudeCodeVersion(floorError("2.1.280", "2.1.110"))).toBe(false);
    expect(claudeCodeUserAgent()).toContain("2.1.280");
  });

  it("ignores unrelated 400s", () => {
    expect(adoptRequiredClaudeCodeVersion(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "You're out of extra usage" } }))).toBe(false);
    expect(adoptRequiredClaudeCodeVersion("")).toBe(false);
  });
});

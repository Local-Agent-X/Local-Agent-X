// Regression tests for TD-11 (arg-derived ARI action) + TD-10 (rate-limit reset
// horizon + no-drop of warn/throttle over-limit warnings).
//
// TD-11: ARI_ACTION_MAP is per-tool-NAME, so http_request always read as "get"
// and browser always "get" — a POST or a browser click/evaluate looked passive,
// and a preset that denies http WRITES could never see them. deriveAriAction
// derives the action from the call's args. These tests pin the mapping AND drive
// the real arikernel workspace-assistant preset to prove a CLEAN post is allowed
// while a web/rag/email-tainted post is denied. Both fail on the static-map code.
//
// TD-10: checkLimit computed resetInMs and threw it away (block reason had no
// "resets in Ns"), and a warn/throttle OVER-limit result was silently downgraded
// to a bare allow in check(). These tests fail on the pre-fix rate-limiter.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAriAction } from "./enforce-policy.js";
import { ToolRateLimiter } from "./rate-limiter.js";
import { startAriKernel, stopAriKernel } from "../ari-kernel/lifecycle.js";
import { ariEvaluate } from "../ari-kernel/evaluate.js";

describe("TD-11 · deriveAriAction — action derived from args, not the static per-name map", () => {
  it("maps http_request by HTTP verb: writes → the write action, reads → get", () => {
    expect(deriveAriAction("http_request", { method: "POST" })).toBe("post");
    expect(deriveAriAction("http_request", { method: "put" })).toBe("put");
    expect(deriveAriAction("http_request", { method: "PATCH" })).toBe("patch");
    expect(deriveAriAction("http_request", { method: "DELETE" })).toBe("delete");
    expect(deriveAriAction("http_request", { method: "GET" })).toBe("get");
    expect(deriveAriAction("http_request", { method: "HEAD" })).toBe("get");
    // Absent method defaults to a read, never a write.
    expect(deriveAriAction("http_request", {})).toBe("get");
    // The pre-fix static map returned "get" for EVERY http_request — this line
    // (POST → "post") is what fails on the old code.
    expect(deriveAriAction("http_request", { method: "POST" })).not.toBe("get");
  });

  it("maps browser by sub-action: mutating actions → post, passive → get", () => {
    for (const a of ["click", "fill", "select", "type", "evaluate", "act"]) {
      expect(deriveAriAction("browser", { action: a })).toBe("post");
    }
    for (const a of ["navigate", "read", "screenshot"]) {
      expect(deriveAriAction("browser", { action: a })).toBe("get");
    }
    expect(deriveAriAction("browser", {})).toBe("get");
  });

  it("falls back to the static ARI_ACTION_MAP for non-arg-derivable tools", () => {
    expect(deriveAriAction("read", {})).toBe("read");
    expect(deriveAriAction("write", {})).toBe("write");
    expect(deriveAriAction("bash", {})).toBe("exec");
    expect(deriveAriAction("memory_save", {})).toBe("mutate");
    // Unmapped tool → "exec" fallback (fail-closed at the kernel).
    expect(deriveAriAction("totally_unknown_tool", {})).toBe("exec");
  });
});

describe("TD-11 · derived action under the live workspace-assistant preset", () => {
  let dir: string;
  const prevKey = process.env.LAX_AUDIT_KEY;

  beforeEach(async () => {
    process.env.LAX_AUDIT_KEY = "test-td11-derive-action-key-0123456789";
    dir = mkdtempSync(join(tmpdir(), "lax-td11-"));
    await startAriKernel(join(dir, "ari-audit.db"), "workspace-assistant", true);
  });
  afterEach(() => {
    stopAriKernel();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevKey === undefined) delete process.env.LAX_AUDIT_KEY;
    else process.env.LAX_AUDIT_KEY = prevKey;
  });

  it("a CLEAN http POST is ALLOWED (allow-http-write-clean)", async () => {
    const action = deriveAriAction("http_request", { method: "POST", url: "https://example.com" });
    expect(action).toBe("post");
    const r = await ariEvaluate("http_request", action, { method: "POST", url: "https://example.com" }, []);
    expect(r.allowed).toBe(true);
  });

  it("a web/rag/email-tainted http POST is DENIED (deny-tainted-http-write) while GET stays allowed", async () => {
    const postAction = deriveAriAction("http_request", { method: "POST", url: "https://example.com" });
    for (const taint of ["web", "rag", "email"]) {
      const denied = await ariEvaluate("http_request", postAction, { method: "POST", url: "https://example.com" }, [taint]);
      expect(denied.allowed).toBe(false);
    }
    // The SAME tool as a GET is unaffected — proves the deny keyed on the
    // derived write action, which the static "get" map could never surface.
    const getAction = deriveAriAction("http_request", { method: "GET", url: "https://example.com" });
    const getRes = await ariEvaluate("http_request", getAction, { method: "GET", url: "https://example.com" }, ["web"]);
    expect(getRes.allowed).toBe(true);
  });

  it("a tainted browser click (derived → post) is DENIED, a navigate (→ get) is allowed", async () => {
    const clickAction = deriveAriAction("browser", { action: "click" });
    expect(clickAction).toBe("post");
    const clickDenied = await ariEvaluate("browser", clickAction, { action: "click" }, ["web"]);
    expect(clickDenied.allowed).toBe(false);

    const navAction = deriveAriAction("browser", { action: "navigate" });
    const navRes = await ariEvaluate("browser", navAction, { action: "navigate" }, ["web"]);
    expect(navRes.allowed).toBe(true);
  });
});

describe("TD-10 · rate-limit reset horizon + warn/throttle warning is not dropped", () => {
  it("a blocked denial's reason carries the reset horizon ('resets in Ns')", () => {
    const rl = new ToolRateLimiter([{ tool: "http_request", maxCalls: 2, windowMs: 60_000, action: "block" }]);
    rl.record("http_request", "s1");
    rl.record("http_request", "s1");
    const res = rl.check("http_request", "s1");
    expect(res.allowed).toBe(false);
    expect(res.action).toBe("block");
    expect(res.reason).toMatch(/resets in \d+s/);
    // The reset horizon is a real, positive figure (not the discarded 0).
    expect(res.resetInMs).toBeGreaterThan(0);
  });

  it("a warn over-limit result is SURFACED, not downgraded to a bare allow", () => {
    // Global "*" under its cap so the pre-fix code would fall through to it and
    // return a bare {action:"allow"} — dropping the tool-specific warning.
    const rl = new ToolRateLimiter([
      { tool: "web_fetch", maxCalls: 1, windowMs: 60_000, action: "warn" },
      { tool: "*", maxCalls: 1000, windowMs: 60_000, action: "block" },
    ]);
    rl.record("web_fetch", "s1");
    const res = rl.check("web_fetch", "s1");
    expect(res.allowed).toBe(true);       // warn allows the call…
    expect(res.action).toBe("warn");      // …but the warning is surfaced, not "allow"
    expect(res.reason).toMatch(/Rate limit exceeded/);
    expect(res.reason).toMatch(/resets in \d+s/);
  });

  it("a throttle over-limit result is likewise surfaced", () => {
    const rl = new ToolRateLimiter([
      { tool: "web_search", maxCalls: 1, windowMs: 30_000, action: "throttle" },
    ]);
    rl.record("web_search", "s1");
    const res = rl.check("web_search", "s1");
    expect(res.allowed).toBe(true);
    expect(res.action).toBe("throttle");
    expect(res.reason).toMatch(/resets in \d+s/);
  });

  it("a hard block on the GLOBAL limit still wins over a tool-specific warning", () => {
    const rl = new ToolRateLimiter([
      { tool: "web_fetch", maxCalls: 1, windowMs: 60_000, action: "warn" },
      { tool: "*", maxCalls: 1, windowMs: 60_000, action: "block" },
    ]);
    rl.record("web_fetch", "s1"); // fills both the tool-specific AND the global window
    const res = rl.check("web_fetch", "s1");
    expect(res.allowed).toBe(false);
    expect(res.action).toBe("block");
  });
});

/**
 * Ownership pins for the session/op-keyed shared state in src/tool-execution
 * and src/tools — one test per holder whose scope is load-bearing.
 *
 * Written by the 2026-09-10 shared-state ownership audit (chunk C3). Every
 * assertion here CHARACTERIZES verified current behavior; nothing was changed
 * to make one pass. The two `read_my_logs` cases pin a PARKED hazard on
 * purpose, and say so — a fix must consciously update them.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRateLimiter } from "./rate-limiter.js";
import { dedupLookup, dedupRecord, _clearDedupCacheForTests } from "./dedup-cache.js";
import { resolvePhase } from "./resolve-tool.js";
import { createContext } from "./context.js";
import type { SecurityLayer } from "../security/index.js";
import {
  recordFileSeen,
  checkFreshness,
  unchangedSinceSeen,
  forgetSessionReads,
} from "../tools/read-state.js";

const LIMITS = [{ tool: "probe", maxCalls: 2, windowMs: 60_000, action: "block" as const }];

async function resolveArgs(name: string, sessionId: string | undefined, args: Record<string, unknown>) {
  const ctx = createContext({
    tc: { id: "t-shared-state", name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: {} as SecurityLayer,
    sessionId,
    callContext: "delegated",
  });
  const outcome = await resolvePhase(ctx);
  expect(outcome.kind).toBe("continue");
  return ctx.args;
}

describe("rate limiter — the unit of work is the tool session", () => {
  it("one session exhausting a per-tool cap does not throttle another session", () => {
    const limiter = new ToolRateLimiter(LIMITS);
    limiter.record("probe", "session-a");
    limiter.record("probe", "session-a");
    expect(limiter.check("probe", "session-a").allowed).toBe(false);
    // The whole point: session-b's budget is its own.
    const b = limiter.check("probe", "session-b");
    expect(b.allowed).toBe(true);
    // `check()` collapses every passing result to remaining:-1 — the per-tool
    // remaining it computed is discarded on the allow path, so getUsage() is
    // the only honest reader of how much budget a session has left.
    expect(b.remaining).toBe(-1);
    expect(limiter.getUsage("session-b").probe).toEqual({ used: 0, limit: 2, windowMs: 60_000 });
    expect(limiter.getUsage("session-a").probe.used).toBe(2);
  });

  it("the global '*' bucket is per-session too, not one process-wide counter", () => {
    const limiter = new ToolRateLimiter([
      ...LIMITS,
      { tool: "*", maxCalls: 2, windowMs: 60_000, action: "block" },
    ]);
    limiter.record("other", "session-a");
    limiter.record("other", "session-a");
    expect(limiter.check("other", "session-a").allowed).toBe(false);
    expect(limiter.check("other", "session-b").allowed).toBe(true);
  });

  it("callers that pass no session all share the one 'default' bucket", () => {
    // Not a bug — the documented fallback. Pinned so the collapse stays
    // deliberate: two session-less dispatches DO share a budget.
    const limiter = new ToolRateLimiter(LIMITS);
    limiter.record("probe");
    limiter.record("probe");
    expect(limiter.check("probe").allowed).toBe(false);
    expect(limiter.check("probe", "default").allowed).toBe(false);
  });
});

describe("dedup cache — scope isolation", () => {
  afterEach(() => _clearDedupCacheForTests());

  it("a record made under one scope is invisible to another scope", () => {
    dedupRecord("run-1", "web_search", '{"q":"x"}', {
      msgs: [], allowed: true, resultContent: "first",
    });
    expect(dedupLookup("run-1", "web_search", '{"q":"x"}')?.resultContent).toBe("first");
    expect(dedupLookup("run-2", "web_search", '{"q":"x"}')).toBeNull();
  });

  it("a scope-less call neither records nor reads", () => {
    dedupRecord(undefined, "web_search", '{"q":"y"}', {
      msgs: [], allowed: true, resultContent: "nope",
    });
    expect(dedupLookup(undefined, "web_search", '{"q":"y"}')).toBeNull();
    expect(dedupLookup("run-1", "web_search", '{"q":"y"}')).toBeNull();
  });

  it("argument key order does not create a second cache entry", () => {
    dedupRecord("run-1", "web_search", '{"a":1,"b":2}', {
      msgs: [], allowed: true, resultContent: "canonical",
    });
    expect(dedupLookup("run-1", "web_search", '{"b":2,"a":1}')?.resultContent).toBe("canonical");
  });
});

describe("read-state freshness — the stale-read gate is per session", () => {
  let dir: string;
  let file: string;

  afterEach(() => {
    forgetSessionReads("fresh-a");
    forgetSessionReads("fresh-b");
    forgetSessionReads("default");
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function seedFile(): void {
    dir = mkdtempSync(join(tmpdir(), "lax-readstate-"));
    file = join(dir, "note.txt");
    writeFileSync(file, "hello", "utf-8");
  }

  it("one session's read does not make the file editable by another session", () => {
    seedFile();
    recordFileSeen("fresh-a", file);
    expect(checkFreshness("fresh-a", file)).toBe("ok");
    // The gate that matters: B never read it, so B must re-read before editing.
    expect(checkFreshness("fresh-b", file)).toBe("unseen");
    expect(unchangedSinceSeen("fresh-b", file)).toBe(false);
  });

  it("session-less callers share the 'default' bucket (documented collapse)", () => {
    seedFile();
    recordFileSeen(undefined, file);
    expect(checkFreshness("default", file)).toBe("ok");
    expect(checkFreshness(undefined, file)).toBe("ok");
  });

  it("a disk change invalidates the reader's freshness, not just its mtime", () => {
    seedFile();
    recordFileSeen("fresh-a", file);
    writeFileSync(file, "changed", "utf-8");
    expect(checkFreshness("fresh-a", file)).toBe("stale");
  });
});

describe("resolvePhase _sessionId stamping — who gets a trusted session", () => {
  it("session_status is stamped, so it never falls back to the global browser slot", async () => {
    const args = await resolveArgs("session_status", "stamp-me", {});
    expect(args._sessionId).toBe("stamp-me");
  });

  it("browser and the two browser secret tools are stamped as well", async () => {
    for (const name of ["browser", "browser_capture_to_secret", "browser_fill_from_secret"]) {
      const args = await resolveArgs(name, "stamp-me", {});
      expect(args._sessionId, `${name} must carry a trusted session`).toBe("stamp-me");
    }
  });

  it("a session-less dispatch collapses the stamp to 'default'", async () => {
    const args = await resolveArgs("session_status", undefined, {});
    expect(args._sessionId).toBe("default");
  });

  // ── PARKED HAZARD (audit 2026-09-10, chunk C3) ────────────────────────────
  // read_my_logs is wired to the SAME `activeBrowserSessionIdRef` global that
  // its four siblings above read (tools/plugins.ts:116-144), but it is absent
  // from SESSION_SCOPED_TOOLS — so it is the ONE reader of that slot with no
  // trusted per-call session, and falls back to "whichever chat turn last
  // started" (or "default" after any turn's finally). Its own description
  // claims "Scoped to your own session". Pinned as-is: a fix must flip this
  // expectation deliberately, not silently.
  it("read_my_logs is NOT stamped — it falls back to the process-global slot", async () => {
    const args = await resolveArgs("read_my_logs", "stamp-me", {});
    expect(args._sessionId).toBeUndefined();
  });
});

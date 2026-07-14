/**
 * Pins the discriminated-union contract of `applyWrite` (and the matching
 * caller branches in `runEndOfTurnMemoryWrite`).
 *
 * applyWrite was changed from returning void to returning ApplyWriteResult:
 *   - { ok: true }
 *   - { ok: false; blocked: true;  reason: string }   ← gate refusal
 *   - { ok: false; blocked?: false; reason: string }  ← skip / generic
 *
 * The caller switches on `blocked` to emit distinct WARN log lines. If a
 * future refactor silently reverts to void, or collapses the two failure
 * branches, these tests fail loudly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock writeMemorySafely BEFORE importing end-of-turn-write so the binding
// is in place when the module resolves its imports. The real MemoryWriteBlocked
// class is re-exported so tests can throw the exact same shape production
// catches.
const writeMemorySafelyMock = vi.fn();
vi.mock("./write-safely.js", async () => {
  const actual =
    await vi.importActual<typeof import("./write-safely.js")>("./write-safely.js");
  return {
    ...actual,
    writeMemorySafely: writeMemorySafelyMock,
  };
});

// Mock the classifier transport so runEndOfTurnMemoryWrite tests can script
// the decision without an LLM call. __nextDecision is scripted per-test and
// played back as the raw JSON reply on the wire — the real classifySchema
// (schema validation + retry) runs on top of it.
let __nextDecision: unknown = null;
const classifyMock = vi.fn(async () =>
  __nextDecision == null ? null : JSON.stringify(__nextDecision),
);
vi.mock("../classifiers/classify-with-llm.js", () => ({
  classifyWithLLM: classifyMock,
}));

// Mock provider availability — runEndOfTurnMemoryWrite gates on it BEFORE
// consuming the curate signal. null = no credentialed provider.
let __providerCtx: { provider: string; apiKey: string; model: string } | null = {
  provider: "anthropic", apiKey: "k", model: "",
};
vi.mock("../providers/resolve-provider-context.js", () => ({
  resolveProviderContext: vi.fn(async () => __providerCtx),
}));

const { applyWrite, runEndOfTurnMemoryWrite } = await import("./end-of-turn-write.js");
const { boostNudgePriority, hasCurateSignal } = await import("./curate-nudge.js");
const { MemoryWriteBlocked, MAX_PROFILE_CHARS } = await import("./write-safely.js");
const { PERSONALITY_FILES } = await import("./personality.js");

interface FakeMemory {
  getMemoryDir(): string;
}

let tempDir: string;
let memory: FakeMemory;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-eot-"));
  mkdirSync(join(tempDir, "memory"), { recursive: true });
  memory = { getMemoryDir: () => join(tempDir, "memory") };
  writeMemorySafelyMock.mockReset();
  classifyMock.mockClear();
  __nextDecision = null;
  __providerCtx = { provider: "anthropic", apiKey: "k", model: "" };
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function appendDecision(content = "User prefers terse answers."): {
  write: true;
  action: "append";
  section_heading: null;
  content: string;
} {
  return { write: true, action: "append", section_heading: null, content };
}

describe("applyWrite — discriminated-union return contract", () => {
  it("returns { ok: true } when writeMemorySafely resolves", async () => {
    writeMemorySafelyMock.mockReturnValueOnce(undefined);

    const result = await applyWrite(
      appendDecision(),
      memory as unknown as Parameters<typeof applyWrite>[1],
    );

    expect(result).toEqual({ ok: true });
    if (result.ok) {
      // narrow check — `ok: true` variant has no `reason` / `blocked` fields
      expect((result as Record<string, unknown>).reason).toBeUndefined();
      expect((result as Record<string, unknown>).blocked).toBeUndefined();
    }
    expect(writeMemorySafelyMock).toHaveBeenCalledTimes(1);
  });

  it("returns { ok: false, blocked: true, reason } when MemoryWriteBlocked is thrown", async () => {
    const blockedReason = "external untrusted marker";
    writeMemorySafelyMock.mockImplementationOnce(() => {
      throw new MemoryWriteBlocked({
        reason: blockedReason,
        injectionScore: 0.95,
        source: "eot",
        target: join(tempDir, "memory", PERSONALITY_FILES.user),
      });
    });

    const result = await applyWrite(
      appendDecision(),
      memory as unknown as Parameters<typeof applyWrite>[1],
    );

    // Pin the discriminated property — this is the contract the caller's
    // switch depends on. A regression that drops `blocked: true` would make
    // the caller log the wrong WARN line.
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, blocked: true, reason: blockedReason });
    if (!result.ok) {
      expect(result.blocked).toBe(true);
    }
  });

  it("rethrows generic errors (caller's try/catch handles them) — NOT { blocked: true }", async () => {
    // Production semantics: only MemoryWriteBlocked is caught and reshaped
    // into the discriminated union. Anything else propagates so the caller
    // can log a generic "write failed" line.
    writeMemorySafelyMock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    await expect(
      applyWrite(
        appendDecision(),
        memory as unknown as Parameters<typeof applyWrite>[1],
      ),
    ).rejects.toThrow(/disk full/);
  });

  it("returns { ok: false, reason: /limit/i } and does NOT set blocked when char limit is exceeded", async () => {
    // Seed USER.md with content just under the cap so the next append
    // pushes it over the USER.md char cap.
    const userPath = join(tempDir, "memory", PERSONALITY_FILES.user);
    writeFileSync(userPath, "x".repeat(MAX_PROFILE_CHARS - 50), "utf-8");

    const result = await applyWrite(
      appendDecision("y".repeat(200)), // (cap - 50) + ~200 > cap
      memory as unknown as Parameters<typeof applyWrite>[1],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(new RegExp(String(MAX_PROFILE_CHARS)));
      // blocked must be absent (or false) on the char-limit branch so the
      // caller's switch routes to the generic "skipped" WARN, not the
      // taint-gate WARN.
      expect(result.blocked).toBeFalsy();
    }
    expect(writeMemorySafelyMock).not.toHaveBeenCalled();
  });
});

describe("runEndOfTurnMemoryWrite — caller emits distinct WARN lines per variant", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // src/logger.ts routes warn + error through console.error (stderr split),
    // and info + debug through console.log. Spy at the console layer so we
    // don't have to crack the logger module open.
    warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  function findWarn(needle: RegExp): string | undefined {
    for (const call of warnSpy.mock.calls) {
      const joined = call.map(String).join(" ");
      if (needle.test(joined)) return joined;
    }
    return undefined;
  }

  it("logs a WARN containing 'BLOCKED' when applyWrite returns blocked:true", async () => {
    __nextDecision = appendDecision();
    writeMemorySafelyMock.mockImplementationOnce(() => {
      throw new MemoryWriteBlocked({
        reason: "external marker present",
        injectionScore: 0.95,
        source: "eot",
        target: join(tempDir, "memory", PERSONALITY_FILES.user),
      });
    });

    await runEndOfTurnMemoryWrite({
      sessionId: "sess-block",
      userMessage: "hello",
      assistantReply: "hi",
      memory: memory as unknown as Parameters<typeof runEndOfTurnMemoryWrite>[0]["memory"],
    });

    const blockedLine = findWarn(/blocked/i);
    expect(blockedLine).toBeDefined();
    expect(blockedLine).toMatch(/external marker present/);
  });

  it("logs a WARN that does NOT say 'blocked' when applyWrite returns ok:false without the flag", async () => {
    // Char-limit branch returns { ok: false, reason } with no blocked:true.
    const userPath = join(tempDir, "memory", PERSONALITY_FILES.user);
    writeFileSync(userPath, "x".repeat(MAX_PROFILE_CHARS - 50), "utf-8");

    __nextDecision = appendDecision("y".repeat(200));

    await runEndOfTurnMemoryWrite({
      sessionId: "sess-skip",
      userMessage: "hello",
      assistantReply: "hi",
      memory: memory as unknown as Parameters<typeof runEndOfTurnMemoryWrite>[0]["memory"],
    });

    const skipLine = findWarn(/skipped/i);
    expect(skipLine).toBeDefined();
    // The two WARN variants must be distinguishable — the skipped line
    // does NOT carry the "BLOCKED" phrase the gated line uses.
    expect(skipLine).not.toMatch(/BLOCKED/);
    expect(skipLine).toMatch(new RegExp(String(MAX_PROFILE_CHARS))); // reason carried through
  });
});

describe("runEndOfTurnMemoryWrite — availability gating (unavailable ≠ success)", () => {
  function ctxFor(sessionId: string) {
    return {
      sessionId,
      userMessage: "always sort my reports by date",
      assistantReply: "got it",
      memory: memory as unknown as Parameters<typeof runEndOfTurnMemoryWrite>[0]["memory"],
    };
  }

  it("no credentialed provider → 'unavailable': signal NOT consumed, classifier NOT called; a later run with a provider extracts with the survived signal", async () => {
    const sess = "sess-avail-1";
    boostNudgePriority(sess, "explicit-remember");
    expect(hasCurateSignal(sess)).toBe(true);

    // Phase 1 — settings point at a dead provider (the soak config class).
    __providerCtx = null;
    const outcome = await runEndOfTurnMemoryWrite(ctxFor(sess));
    expect(outcome).toBe("unavailable");
    expect(classifyMock).not.toHaveBeenCalled();
    // The trigger signal survives — it was NOT consumed by an impossible run.
    expect(hasCurateSignal(sess)).toBe(true);

    // Phase 2 — provider comes back: the survived signal drives a real pass.
    __providerCtx = { provider: "anthropic", apiKey: "k", model: "" };
    __nextDecision = appendDecision();
    writeMemorySafelyMock.mockReturnValueOnce(undefined);
    const outcome2 = await runEndOfTurnMemoryWrite(ctxFor(sess));
    expect(outcome2).toBe("completed");
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(writeMemorySafelyMock).toHaveBeenCalledTimes(1);
    // Signal consumed by the run that actually happened.
    expect(hasCurateSignal(sess)).toBe(false);
  });

  it("env kill switch → 'unavailable' and the signal is preserved", async () => {
    const sess = "sess-avail-2";
    boostNudgePriority(sess, "preference-stated");
    process.env.LAX_MEMORY_END_OF_TURN = "0";
    try {
      const outcome = await runEndOfTurnMemoryWrite(ctxFor(sess));
      expect(outcome).toBe("unavailable");
      expect(classifyMock).not.toHaveBeenCalled();
      expect(hasCurateSignal(sess)).toBe(true);
    } finally {
      delete process.env.LAX_MEMORY_END_OF_TURN;
    }
  });

  it("credentialed path pinned: a decision (even write=false) completes and consumes the signal", async () => {
    const sess = "sess-avail-3";
    boostNudgePriority(sess, "correction-detected");
    __nextDecision = { write: false };
    const outcome = await runEndOfTurnMemoryWrite(ctxFor(sess));
    expect(outcome).toBe("completed");
    expect(hasCurateSignal(sess)).toBe(false);
    expect(writeMemorySafelyMock).not.toHaveBeenCalled();
  });

  it("null decision after a reachable classifier is 'completed' (transient failure, not unavailability)", async () => {
    const sess = "sess-avail-4";
    boostNudgePriority(sess, "explicit-remember");
    __nextDecision = null; // timeout / parse failure
    const outcome = await runEndOfTurnMemoryWrite(ctxFor(sess));
    expect(outcome).toBe("completed");
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(hasCurateSignal(sess)).toBe(false); // consumed — pre-existing semantics
  });
});

describe("runEndOfTurnMemoryWrite — schema-validated decision (classifySchema wire)", () => {
  function ctxFor(sessionId: string) {
    return {
      sessionId,
      userMessage: "always sort my reports by date",
      assistantReply: "got it",
      memory: memory as unknown as Parameters<typeof runEndOfTurnMemoryWrite>[0]["memory"],
    };
  }

  it("a valid write decision on the wire lands the write", async () => {
    __nextDecision = appendDecision();
    writeMemorySafelyMock.mockReturnValueOnce(undefined);
    const outcome = await runEndOfTurnMemoryWrite(ctxFor("sess-schema-ok"));
    expect(outcome).toBe("completed");
    expect(classifyMock).toHaveBeenCalledTimes(1);
    expect(writeMemorySafelyMock).toHaveBeenCalledTimes(1);
  });

  it("valid JSON with an oversized content is rejected by the schema — one retry, then no write", async () => {
    __nextDecision = appendDecision("x".repeat(801)); // schema cap is 800
    const outcome = await runEndOfTurnMemoryWrite(ctxFor("sess-schema-cap"));
    expect(outcome).toBe("completed"); // transient failure, not unavailability
    expect(classifyMock).toHaveBeenCalledTimes(2); // the single self-correction retry
    expect(writeMemorySafelyMock).not.toHaveBeenCalled();
  });

  it("the retired legacy file:\"mind\" is rejected → no write", async () => {
    __nextDecision = { ...appendDecision(), file: "mind" };
    await runEndOfTurnMemoryWrite(ctxFor("sess-schema-mind"));
    expect(writeMemorySafelyMock).not.toHaveBeenCalled();
  });

  it("file:\"user\" (legacy but accepted) still writes", async () => {
    __nextDecision = { ...appendDecision(), file: "user" };
    writeMemorySafelyMock.mockReturnValueOnce(undefined);
    await runEndOfTurnMemoryWrite(ctxFor("sess-schema-user"));
    expect(writeMemorySafelyMock).toHaveBeenCalledTimes(1);
  });

  it("replace_section without a section_heading is rejected → no write", async () => {
    __nextDecision = { write: true, action: "replace_section", section_heading: "   ", content: "c" };
    await runEndOfTurnMemoryWrite(ctxFor("sess-schema-heading"));
    expect(writeMemorySafelyMock).not.toHaveBeenCalled();
  });

  it("non-JSON garbage on the wire → retried once → null decision → no write, 'completed'", async () => {
    classifyMock
      .mockResolvedValueOnce("I don't think we should write anything.")
      .mockResolvedValueOnce("Still prose, sorry.");
    const outcome = await runEndOfTurnMemoryWrite(ctxFor("sess-schema-garbage"));
    expect(outcome).toBe("completed");
    expect(classifyMock).toHaveBeenCalledTimes(2);
    expect(writeMemorySafelyMock).not.toHaveBeenCalled();
  });

  it("garbage first reply, valid decision on the self-correction retry → the write lands", async () => {
    classifyMock
      .mockResolvedValueOnce("hmm let me think")
      .mockResolvedValueOnce(JSON.stringify(appendDecision()));
    writeMemorySafelyMock.mockReturnValueOnce(undefined);
    const outcome = await runEndOfTurnMemoryWrite(ctxFor("sess-schema-retry"));
    expect(outcome).toBe("completed");
    expect(classifyMock).toHaveBeenCalledTimes(2);
    expect(writeMemorySafelyMock).toHaveBeenCalledTimes(1);
  });
});

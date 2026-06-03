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

// Mock the classifier so runEndOfTurnMemoryWrite tests can script the
// decision without an LLM call. __nextDecision is scripted per-test.
let __nextDecision: unknown = null;
vi.mock("../classifiers/classify-with-llm.js", () => ({
  classifyWithLLM: vi.fn(async () => __nextDecision),
}));

const { applyWrite, runEndOfTurnMemoryWrite } = await import("./end-of-turn-write.js");
const { MemoryWriteBlocked } = await import("./write-safely.js");
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
  __nextDecision = null;
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
    // pushes it over the 2000-char USER.md limit.
    const userPath = join(tempDir, "memory", PERSONALITY_FILES.user);
    writeFileSync(userPath, "x".repeat(1950), "utf-8");

    const result = await applyWrite(
      appendDecision("y".repeat(200)), // 1950 + ~200 > 2000
      memory as unknown as Parameters<typeof applyWrite>[1],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/2000/);
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
    writeFileSync(userPath, "x".repeat(1950), "utf-8");

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
    expect(skipLine).toMatch(/2000/); // reason carried through
  });
});

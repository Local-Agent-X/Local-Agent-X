/**
 * Regression suite for src/voice/voice-auth.ts — cosine-similarity scoring,
 * the verify() threshold gate, and the per-user rate limiter.
 *
 * cosineSim() and extractEmbeddings() are NOT exported, so we drive them
 * through the public verify()/enroll() surface. extractEmbeddings() shells
 * out to a Python+librosa script via execFileSync; we replace that with a
 * mock that treats the "audio buffer" as a JSON-encoded number[][] of
 * embeddings and copies it straight to the script's output file. That gives
 * us deterministic, librosa-free control over the embeddings that flow into
 * cosineSim(), the threshold compare, and the rate-limit counter — exercising
 * the real production code paths in voice-auth.ts.
 *
 * AUTH_DIR/TMP_DIR are captured at module load from getLaxDir(), which honors
 * LAX_DATA_DIR. We therefore point LAX_DATA_DIR at a fresh temp dir and use a
 * dynamic import() so the module binds to the temp dir, not ~/.lax.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the Python sidecar: the "audio buffer" written to argv[1] (the wav
// path) is actually a JSON-encoded number[][]; copy it to argv[2] (outPath)
// so extractEmbeddings() parses it back into embeddings. This keeps all the
// real cosineSim / threshold / rate-limit logic in play.
vi.mock("node:child_process", () => ({
  execFileSync: (_cmd: string, args: string[]) => {
    const wavPath = args[1];
    const outPath = args[2];
    const raw = readFileSync(wavPath, "utf-8");
    writeFileSync(outPath, raw, "utf-8");
    return Buffer.alloc(0);
  },
}));

/** Build a Buffer that our mocked extractEmbeddings() decodes to `embs`. */
function audio(embs: number[][]): Buffer {
  return Buffer.from(JSON.stringify(embs), "utf-8");
}

type VoiceAuth = typeof import("../src/voice/voice-auth.js");

let dataDir: string;
let voiceAuth: VoiceAuth;
const savedDataDir = process.env.LAX_DATA_DIR;

beforeEach(async () => {
  vi.resetModules();
  dataDir = mkdtempSync(join(tmpdir(), "lax-voice-auth-"));
  process.env.LAX_DATA_DIR = dataDir;
  // Fresh module instance binds AUTH_DIR/TMP_DIR + the in-memory rate-limit
  // map to this test's temp dir, isolating state between tests.
  voiceAuth = await import("../src/voice/voice-auth.js");
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = savedDataDir;
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.useRealTimers();
});

describe("cosineSim (exercised via enroll + verify scoring)", () => {
  it("scores identical embeddings at confidence 1.0 (full match)", () => {
    const v = [1, 2, 3, 4];
    voiceAuth.enroll("u1", "Alice", [audio([v])]);
    const r = voiceAuth.verify("u1", audio([v]));
    expect(r.confidence).toBeCloseTo(1.0, 10);
    expect(r.authenticated).toBe(true);
  });

  it("scores orthogonal embeddings at confidence 0 (no match)", () => {
    voiceAuth.enroll("u1", "Alice", [audio([[1, 0]])]);
    const r = voiceAuth.verify("u1", audio([[0, 1]]));
    expect(r.confidence).toBeCloseTo(0, 10);
    expect(r.authenticated).toBe(false);
  });

  it("treats a zero vector safely — cosineSim returns 0, never NaN/Infinity", () => {
    // d === Math.sqrt(0)*Math.sqrt(...) === 0, so the guard returns 0.
    voiceAuth.enroll("u1", "Alice", [audio([[0, 0, 0]])]);
    const r = voiceAuth.verify("u1", audio([[0, 0, 0]]));
    expect(Number.isNaN(r.confidence)).toBe(false);
    expect(Number.isFinite(r.confidence)).toBe(true);
    expect(r.confidence).toBe(0);
    expect(r.authenticated).toBe(false);
  });

  it("returns confidence 0 when embedding lengths differ (length-guard, no crash)", () => {
    voiceAuth.enroll("u1", "Alice", [audio([[1, 2, 3]])]);
    const r = voiceAuth.verify("u1", audio([[1, 2]]));
    expect(r.confidence).toBe(0);
    expect(r.authenticated).toBe(false);
  });

  it("never returns NaN/Infinity confidence even when a vector magnitude is zero", () => {
    // A zero enrolled print vs any test vector: mA (or mB) is 0, so the
    // divisor d is 0 and the guard returns 0 rather than 0/0 = NaN. This is
    // the only place cosineSim can produce a non-finite value, and it's
    // guarded. Confirm confidence stays finite and the gate stays closed.
    voiceAuth.enroll("u1", "Alice", [audio([[0, 0, 0]])]);
    const r = voiceAuth.verify("u1", audio([[1, 2, 3]]));
    expect(Number.isFinite(r.confidence)).toBe(true);
    expect(Number.isNaN(r.confidence)).toBe(false);
    expect(r.confidence).toBe(0);
    expect(r.authenticated).toBe(false);
  });

  it("PINS current behavior: a null/missing component is coerced to 0, not rejected", () => {
    // Defect-adjacent note: cosineSim does no per-element finiteness check.
    // JSON (the sidecar's wire format) has no NaN — non-finite values arrive
    // as null and JS arithmetic coerces null -> 0. So an embedding of
    // [null,2,3] is scored as [0,2,3], inflating similarity rather than being
    // treated as invalid input. Locking in current behavior.
    voiceAuth.enroll("u1", "Alice", [audio([[1, 2, 3]])]);
    const r = voiceAuth.verify("u1", audio([[null as unknown as number, 2, 3]]));
    expect(Number.isFinite(r.confidence)).toBe(true);
    // [0,2,3] vs [1,2,3]: cos = 13 / (sqrt(13)*sqrt(14)) ~ 0.964 -> passes.
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.authenticated).toBe(true);
  });

  it("picks the BEST average across multiple test windows", () => {
    // One enrolled print; two test windows — one orthogonal (0), one identical
    // (1.0). verify() keeps the max, so confidence ~ 1.0.
    voiceAuth.enroll("u1", "Alice", [audio([[1, 0]])]);
    const r = voiceAuth.verify("u1", audio([[0, 1], [1, 0]]));
    expect(r.confidence).toBeCloseTo(1.0, 10);
    expect(r.authenticated).toBe(true);
  });
});

describe("verify() threshold gate", () => {
  it("accepts when the best average meets the threshold exactly (>=)", () => {
    const v = [3, 4, 0];
    voiceAuth.enroll("u1", "Bob", [audio([v])]);
    // Identical -> confidence 1.0; a threshold of exactly 1.0 must still pass.
    const r = voiceAuth.verify("u1", audio([v]), 1.0);
    expect(r.confidence).toBeCloseTo(1.0, 10);
    expect(r.authenticated).toBe(true);
  });

  it("rejects when confidence is below threshold", () => {
    // cos between [1,1] and [1,0] = 1/sqrt(2) ~ 0.707 < default 0.82.
    voiceAuth.enroll("u1", "Bob", [audio([[1, 1]])]);
    const r = voiceAuth.verify("u1", audio([[1, 0]]));
    expect(r.confidence).toBeCloseTo(Math.SQRT1_2, 6);
    expect(r.threshold).toBe(0.82);
    expect(r.authenticated).toBe(false);
  });

  it("accepts a near-match that clears a lenient threshold", () => {
    voiceAuth.enroll("u1", "Bob", [audio([[1, 1]])]);
    const r = voiceAuth.verify("u1", audio([[1, 0]]), 0.7);
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.authenticated).toBe(true);
  });

  it("returns authenticated=false with empty label when the user is not enrolled", () => {
    const r = voiceAuth.verify("ghost", audio([[1, 2, 3]]));
    expect(r.authenticated).toBe(false);
    expect(r.label).toBe("");
    expect(r.confidence).toBe(0);
  });

  it("persists lastVerified only on a successful auth", () => {
    const v = [1, 2, 3];
    voiceAuth.enroll("u1", "Bob", [audio([v])]);
    voiceAuth.verify("u1", audio([v])); // success -> writes lastVerified
    const path = join(dataDir, "voice-auth", "voiceprints.json");
    const stored = JSON.parse(readFileSync(path, "utf-8"));
    expect(stored[0].lastVerified).toBeTypeOf("string");
  });
});

describe("VERIFY_MAX_ATTEMPTS rate limiter", () => {
  it("blocks the 6th attempt after 5 failures inside the window", () => {
    voiceAuth.enroll("u1", "Carol", [audio([[1, 0]])]);
    const bad = audio([[0, 1]]); // orthogonal -> always fails the threshold

    // 5 attempts are allowed (each fails on confidence, not the limiter).
    for (let i = 0; i < 5; i++) {
      const r = voiceAuth.verify("u1", bad);
      expect(r.authenticated).toBe(false);
      expect(r.label).toBe("Carol"); // still reached the scoring path
    }

    // 6th attempt is rejected by the limiter BEFORE scoring -> label "".
    const blocked = voiceAuth.verify("u1", bad);
    expect(blocked.authenticated).toBe(false);
    expect(blocked.confidence).toBe(0);
    expect(blocked.label).toBe("");
  });

  it("blocks even a would-be-valid voiceprint once the limit is hit", () => {
    const good = audio([[1, 2, 3]]);
    voiceAuth.enroll("u1", "Carol", [good]);

    // Burn 5 successful-or-not attempts to fill the window.
    for (let i = 0; i < 5; i++) voiceAuth.verify("u1", good);

    // A perfect match now still gets blocked by the limiter.
    const blocked = voiceAuth.verify("u1", good);
    expect(blocked.authenticated).toBe(false);
    expect(blocked.label).toBe("");
  });

  it("tracks attempts per-user; one user's failures do not block another", () => {
    voiceAuth.enroll("a", "A", [audio([[0, 1]])]);
    voiceAuth.enroll("b", "B", [audio([[1, 2, 3]])]);
    const bad = audio([[1, 0]]);

    for (let i = 0; i < 6; i++) voiceAuth.verify("a", bad); // exhaust user a
    const blockedA = voiceAuth.verify("a", bad);
    expect(blockedA.label).toBe(""); // a is rate-limited

    const okB = voiceAuth.verify("b", audio([[1, 2, 3]]));
    expect(okB.authenticated).toBe(true); // b is unaffected
  });

  it("lets attempts through again once the window elapses (fake timers)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    voiceAuth.enroll("u1", "Carol", [audio([[0, 1]])]);
    const bad = audio([[1, 0]]);

    for (let i = 0; i < 5; i++) voiceAuth.verify("u1", bad);
    expect(voiceAuth.verify("u1", bad).label).toBe(""); // blocked now

    // Advance past the 60s window; old timestamps age out of recentAttempts.
    vi.advanceTimersByTime(60_001);
    const after = voiceAuth.verify("u1", bad);
    expect(after.label).toBe("Carol"); // reached scoring path again
  });
});

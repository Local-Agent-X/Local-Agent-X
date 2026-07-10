import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recentlyDone,
  markDone,
  fingerprintOf,
  describeAge,
  _clearIdempotencyStoreForTests,
  _resetIdempotencyForTests,
} from "./idempotency.js";

describe("idempotency store", () => {
  beforeEach(() => _clearIdempotencyStoreForTests());

  it("returns null when nothing is recorded", () => {
    expect(recentlyDone("email_send", "fp1", 60_000)).toBeNull();
  });

  it("returns the prior result inside the window", () => {
    markDone("email_send", "fp1", "msg-id-42");
    const hit = recentlyDone("email_send", "fp1", 60_000);
    expect(hit?.result).toBe("msg-id-42");
    expect(hit?.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("isolates by tool name", () => {
    markDone("email_send", "fp1", "x");
    expect(recentlyDone("x_post", "fp1", 60_000)).toBeNull();
  });

  it("isolates by fingerprint", () => {
    markDone("email_send", "fp1", "x");
    expect(recentlyDone("email_send", "fp2", 60_000)).toBeNull();
  });

  it("respects the window — older than window returns null", () => {
    markDone("email_send", "fp1", "x");
    // 0ms window forces age > window for any entry
    expect(recentlyDone("email_send", "fp1", 0)).toBeNull();
  });
});

describe("idempotency persistence across restart", () => {
  const originalDataDir = process.env.LAX_DATA_DIR;
  const STORE_BASENAME = "send-idempotency.json";
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "lax-idem-"));
    process.env.LAX_DATA_DIR = dataDir;
    // Fresh module state pointed at the fresh dir (no persisted file yet).
    _resetIdempotencyForTests();
  });

  afterEach(() => {
    _clearIdempotencyStoreForTests();
    if (originalDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = originalDataDir;
    _resetIdempotencyForTests();
    vi.restoreAllMocks();
  });

  it("survives a simulated restart: recentlyDone hits from disk", () => {
    markDone("email_send", "fp-restart", "messageId=abc");
    _resetIdempotencyForTests(); // process dies; disk snapshot remains
    const hit = recentlyDone("email_send", "fp-restart", 60_000);
    expect(hit?.result).toBe("messageId=abc");
    expect(hit?.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("writes the snapshot with owner-only permissions", () => {
    markDone("email_send", "fp-mode", "x");
    const mode = statSync(join(dataDir, STORE_BASENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("TTL-expired entries do not survive reload", () => {
    markDone("email_send", "fp-old", "stale");
    // Age the persisted entry past the 24h sweep window on disk.
    const file = join(dataDir, STORE_BASENAME);
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, { ts: number; result: string }>;
    for (const v of Object.values(raw)) v.ts = Date.now() - 25 * 60 * 60 * 1000;
    writeFileSync(file, JSON.stringify(raw));
    _resetIdempotencyForTests();
    expect(recentlyDone("email_send", "fp-old", Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("a corrupt snapshot degrades to process-local semantics, not a throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(dataDir, STORE_BASENAME), "{not json");
    _resetIdempotencyForTests();
    expect(recentlyDone("email_send", "fp-corrupt", 60_000)).toBeNull();
    expect(warn).toHaveBeenCalled();
    // The store still works in-process after the failed load.
    markDone("email_send", "fp-corrupt", "ok");
    expect(recentlyDone("email_send", "fp-corrupt", 60_000)?.result).toBe("ok");
  });

  it("persistence failure never throws into the send path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Point the data dir UNDER a regular file so mkdir/write fails (ENOTDIR).
    const blocker = join(dataDir, "blocker");
    writeFileSync(blocker, "i am a file");
    process.env.LAX_DATA_DIR = join(blocker, "nested");
    _resetIdempotencyForTests();
    expect(() => markDone("email_send", "fp-unwritable", "sent")).not.toThrow();
    expect(warn).toHaveBeenCalled();
    // In-memory Map remains authoritative for the process lifetime.
    expect(recentlyDone("email_send", "fp-unwritable", 60_000)?.result).toBe("sent");
    // ...but a restart loses it, because nothing could be persisted.
    _resetIdempotencyForTests();
    expect(recentlyDone("email_send", "fp-unwritable", 60_000)).toBeNull();
  });
});

describe("fingerprintOf", () => {
  it("is stable for the same inputs", () => {
    expect(fingerprintOf("a", "b", "c")).toBe(fingerprintOf("a", "b", "c"));
  });

  it("trims whitespace per part", () => {
    expect(fingerprintOf(" a ", "b")).toBe(fingerprintOf("a", "b"));
  });

  it("treats missing parts as empty", () => {
    expect(fingerprintOf("a", "", "c")).not.toBe(fingerprintOf("a", "c"));
    // ^^ the empty middle part still occupies a slot, so the joined
    // representation differs from omitting it. Documents the behavior:
    // callers should pass placeholders consistently across calls.
  });
});

describe("describeAge", () => {
  it("formats ms windows", () => {
    expect(describeAge(500)).toBe("just now");
    expect(describeAge(30_000)).toBe("30s ago");
    expect(describeAge(5 * 60_000)).toBe("5 min ago");
    expect(describeAge(2 * 3_600_000)).toBe("2h ago");
  });
});

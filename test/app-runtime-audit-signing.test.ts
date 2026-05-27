import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

// paths.ts captures AUDIT_DIR at module-load time using getLaxDir(). The
// end-to-end test below writes through that captured path, then cleans
// the test's own app subdirectory afterward. The audit-key persistence
// tests live in a per-test tempdir via LAX_DATA_DIR + cache reset and
// are not affected by the module-load path.

import {
  GENESIS_PREV_HASH,
  LEGACY_PREV_HASH,
  _resetAuditKeyCacheForTests,
  deriveChainHash,
  getAuditHmacKey,
  signAuditEntry,
  verifyAuditChain,
  verifyAuditEntry,
} from "../src/app-runtime/audit-signing.js";
import { writeAuditEntry } from "../src/app-runtime/audit.js";
import { auditPath } from "../src/app-runtime/paths.js";
import type { AuditEntry } from "../src/app-runtime/types.js";

let tmpRoot: string;
let prevDataDir: string | undefined;
let prevAuditKey: string | undefined;
let prevSaxAuditKey: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lax-audit-test-"));
  prevDataDir = process.env.LAX_DATA_DIR;
  prevAuditKey = process.env.LAX_AUDIT_KEY;
  prevSaxAuditKey = process.env.SAX_AUDIT_KEY;
  process.env.LAX_DATA_DIR = tmpRoot;
  delete process.env.LAX_AUDIT_KEY;
  delete process.env.SAX_AUDIT_KEY;
  _resetAuditKeyCacheForTests();
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
  if (prevAuditKey === undefined) delete process.env.LAX_AUDIT_KEY; else process.env.LAX_AUDIT_KEY = prevAuditKey;
  if (prevSaxAuditKey === undefined) delete process.env.SAX_AUDIT_KEY; else process.env.SAX_AUDIT_KEY = prevSaxAuditKey;
  _resetAuditKeyCacheForTests();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const baseEntry = (over: Partial<Omit<AuditEntry, "signature">> = {}): Omit<AuditEntry, "signature"> => ({
  id: "aud_1",
  timestamp: 1700000000000,
  actor: "user",
  action: "app:create",
  appId: "app1",
  details: {},
  prevHash: GENESIS_PREV_HASH,
  ...over,
});

describe("signAuditEntry", () => {
  it("returns a 16-char hex string", () => {
    const sig = signAuditEntry(baseEntry());
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same input within a process", () => {
    const e = baseEntry();
    expect(signAuditEntry(e)).toBe(signAuditEntry(e));
  });

  it("changes when the action changes", () => {
    expect(signAuditEntry(baseEntry({ action: "app:create" })))
      .not.toBe(signAuditEntry(baseEntry({ action: "app:delete" })));
  });

  it("changes when the actor changes", () => {
    expect(signAuditEntry(baseEntry({ actor: "user" })))
      .not.toBe(signAuditEntry(baseEntry({ actor: "agent-x" })));
  });

  it("changes when the appId changes", () => {
    expect(signAuditEntry(baseEntry({ appId: "a" })))
      .not.toBe(signAuditEntry(baseEntry({ appId: "b" })));
  });

  it("changes when the timestamp changes", () => {
    expect(signAuditEntry(baseEntry({ timestamp: 1 })))
      .not.toBe(signAuditEntry(baseEntry({ timestamp: 2 })));
  });

  it("changes when prevHash changes", () => {
    expect(signAuditEntry(baseEntry({ prevHash: "genesis" })))
      .not.toBe(signAuditEntry(baseEntry({ prevHash: "deadbeef" })));
  });
});

describe("verifyAuditEntry", () => {
  it("returns valid for a freshly signed genesis entry", () => {
    const e = baseEntry();
    const signed: AuditEntry = { ...e, signature: signAuditEntry(e) };
    expect(verifyAuditEntry(signed, null)).toEqual({ valid: true });
  });

  it("returns invalid when the action was tampered with", () => {
    const e = baseEntry({ action: "app:create" });
    const signed: AuditEntry = { ...e, signature: signAuditEntry(e) };
    const tampered: AuditEntry = { ...signed, action: "app:delete" };
    const result = verifyAuditEntry(tampered, null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature mismatch");
  });

  it("returns invalid when the actor was tampered with", () => {
    const e = baseEntry({ actor: "user" });
    const signed: AuditEntry = { ...e, signature: signAuditEntry(e) };
    const tampered: AuditEntry = { ...signed, actor: "system" };
    expect(verifyAuditEntry(tampered, null).valid).toBe(false);
  });

  it("returns invalid when the signature is empty or wrong", () => {
    const e = baseEntry();
    expect(verifyAuditEntry({ ...e, signature: "" }, null).valid).toBe(false);
    expect(verifyAuditEntry({ ...e, signature: "0".repeat(16) }, null).valid).toBe(false);
  });

  it("returns 'pre-chain legacy entry' for legacy entries", () => {
    const e = baseEntry({ prevHash: LEGACY_PREV_HASH });
    const signed: AuditEntry = { ...e, signature: signAuditEntry(e) };
    const result = verifyAuditEntry(signed, null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("pre-chain legacy entry");
  });
});

describe("persistent HMAC key", () => {
  it("creates <laxDir>/audit-key with mode 0o600 on first use", () => {
    signAuditEntry(baseEntry());
    const keyFile = join(tmpRoot, "audit-key");
    expect(existsSync(keyFile)).toBe(true);
    const buf = readFileSync(keyFile);
    expect(buf.length).toBe(32);
    // POSIX file modes — Windows does not enforce 0o600 the same way, so
    // only assert on POSIX. The bytes-written check above is OS-agnostic.
    if (process.platform !== "win32") {
      const mode = statSync(keyFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("reuses an existing on-disk key across resolves", () => {
    const knownKey = Buffer.from("a".repeat(64), "hex");
    writeFileSync(join(tmpRoot, "audit-key"), knownKey, { mode: 0o600 });
    _resetAuditKeyCacheForTests();
    const resolved = getAuditHmacKey();
    expect(Buffer.isBuffer(resolved)).toBe(true);
    expect((resolved as Buffer).equals(knownKey)).toBe(true);

    // Cross-check: signing produces the HMAC computed with that exact key.
    const entry = baseEntry();
    const payload = `${entry.id}|${entry.timestamp}|${entry.actor}|${entry.action}|${entry.appId}|${entry.prevHash}`;
    const expected = createHmac("sha256", knownKey).update(payload).digest("hex").slice(0, 16);
    expect(signAuditEntry(entry)).toBe(expected);
  });

  it("env override beats on-disk key", () => {
    const diskKey = Buffer.from("b".repeat(64), "hex");
    writeFileSync(join(tmpRoot, "audit-key"), diskKey, { mode: 0o600 });
    process.env.LAX_AUDIT_KEY = "envkeyvalue";
    _resetAuditKeyCacheForTests();
    const resolved = getAuditHmacKey();
    expect(resolved).toBe("envkeyvalue");

    const entry = baseEntry();
    const payload = `${entry.id}|${entry.timestamp}|${entry.actor}|${entry.action}|${entry.appId}|${entry.prevHash}`;
    const expected = createHmac("sha256", "envkeyvalue").update(payload).digest("hex").slice(0, 16);
    expect(signAuditEntry(entry)).toBe(expected);
  });
});

describe("hash chain", () => {
  function buildChainedEntry(
    prev: AuditEntry | null,
    overrides: Partial<Omit<AuditEntry, "signature" | "prevHash">> = {},
  ): AuditEntry {
    const prevHash = prev === null ? GENESIS_PREV_HASH : deriveChainHash(prev.signature);
    const unsigned: Omit<AuditEntry, "signature"> = {
      id: overrides.id ?? `aud_${randomBytes(4).toString("hex")}`,
      timestamp: overrides.timestamp ?? Date.now(),
      actor: overrides.actor ?? "user",
      action: overrides.action ?? "app:create",
      appId: overrides.appId ?? "app1",
      details: overrides.details ?? {},
      prevHash,
    };
    return { ...unsigned, signature: signAuditEntry(unsigned) };
  }

  it("first entry uses 'genesis' prevHash", () => {
    const a = buildChainedEntry(null);
    expect(a.prevHash).toBe(GENESIS_PREV_HASH);
    expect(verifyAuditEntry(a, null).valid).toBe(true);
  });

  it("subsequent entry's prevHash is sha256 of prior signature", () => {
    const a = buildChainedEntry(null, { id: "a" });
    const b = buildChainedEntry(a, { id: "b" });
    const expected = createHash("sha256").update(a.signature).digest("hex");
    expect(b.prevHash).toBe(expected);
  });

  it("verifyAuditChain returns valid for a clean chain", () => {
    const a = buildChainedEntry(null, { id: "a" });
    const b = buildChainedEntry(a, { id: "b" });
    const c = buildChainedEntry(b, { id: "c" });
    expect(verifyAuditChain([a, b, c])).toEqual({ valid: true });
  });

  it("verifyAuditChain catches a post-hoc mutation of an interior entry", () => {
    const a = buildChainedEntry(null, { id: "a" });
    const b = buildChainedEntry(a, { id: "b", timestamp: 1000 });
    const c = buildChainedEntry(b, { id: "c" });
    const tamperedB: AuditEntry = { ...b, timestamp: 9999 };
    const result = verifyAuditChain([a, tamperedB, c]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toBe("signature mismatch");
  });

  it("verifyAuditChain catches a wrong prevHash on a downstream entry", () => {
    const a = buildChainedEntry(null, { id: "a" });
    const b = buildChainedEntry(a, { id: "b" });
    const cBase: Omit<AuditEntry, "signature"> = {
      id: "c",
      timestamp: 2000,
      actor: "user",
      action: "app:create",
      appId: "app1",
      details: {},
      prevHash: "00".repeat(32),
    };
    const cBad: AuditEntry = { ...cBase, signature: signAuditEntry(cBase) };
    const result = verifyAuditChain([a, b, cBad]);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.reason).toBe("prevHash mismatch");
  });
});

describe("writeAuditEntry end-to-end", () => {
  it("writes a valid per-app chain across multiple calls", () => {
    // paths.ts snapped AUDIT_DIR at module-load with whatever LAX_DATA_DIR
    // was set then. Resolve where it actually points and write there;
    // clean up after.
    const appId = `chain-test-${randomBytes(4).toString("hex")}`;
    const apath = auditPath(appId);
    const appDir = dirname(apath);
    mkdirSync(appDir, { recursive: true });

    try {
      writeAuditEntry(appId, "user", "app:create");
      writeAuditEntry(appId, "user", "app:update", { field: "name" });
      writeAuditEntry(appId, "user", "app:delete");

      const entries: AuditEntry[] = JSON.parse(readFileSync(apath, "utf-8"));
      expect(entries.length).toBe(3);
      expect(entries[0].prevHash).toBe(GENESIS_PREV_HASH);
      expect(entries[1].prevHash).toBe(deriveChainHash(entries[0].signature));
      expect(entries[2].prevHash).toBe(deriveChainHash(entries[1].signature));
      expect(verifyAuditChain(entries)).toEqual({ valid: true });
    } finally {
      try { rmSync(appDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

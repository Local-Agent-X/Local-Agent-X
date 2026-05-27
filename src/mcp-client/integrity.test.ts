import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCommandPath,
  hashCommandBinary,
  loadTrustStore,
  saveTrustStore,
  verifyOrTrust,
  __trustStorePathForTests,
  __HASH_READ_CAP_BYTES_FOR_TESTS,
} from "./integrity.js";

// Tests redirect LAX_DATA_DIR (and HOME/USERPROFILE for belt-and-
// suspenders) to a mkdtemp dir so they never touch the developer's
// real ~/.lax/mcp-trust.json.
const ENV_KEYS = [
  "LAX_DATA_DIR",
  "HOME",
  "USERPROFILE",
  "LAX_MCP_STRICT_TRUST",
  "LAX_MCP_RETRUST",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

let envSnap: Record<string, string | undefined>;
let tempDir: string;
let dataDir: string;

beforeEach(() => {
  envSnap = snapshotEnv();
  tempDir = mkdtempSync(join(tmpdir(), "lax-mcp-integrity-test-"));
  dataDir = join(tempDir, ".lax");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  process.env.LAX_DATA_DIR = dataDir;
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  delete process.env.LAX_MCP_STRICT_TRUST;
  delete process.env.LAX_MCP_RETRUST;
});

afterEach(() => {
  restoreEnv(envSnap);
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("resolveCommandPath", () => {
  it("returns the absolute path when given one to an existing file", () => {
    const r = resolveCommandPath(process.execPath);
    expect(r).toBe(process.execPath);
  });

  it("returns null when given an absolute path to a missing file", () => {
    const fake = process.platform === "win32"
      ? "C:\\nonexistent\\binary_xyz.exe"
      : "/nonexistent/binary_xyz";
    expect(resolveCommandPath(fake)).toBeNull();
  });

  it("resolves a name on PATH (node)", () => {
    const r = resolveCommandPath("node");
    expect(r).not.toBeNull();
    expect(typeof r).toBe("string");
    if (process.platform === "win32") {
      expect(r!.toLowerCase().endsWith("node.exe")).toBe(true);
    }
  });

  it("returns null when the bare name is not on PATH", () => {
    expect(resolveCommandPath("definitely_not_a_real_binary_xyz")).toBeNull();
  });
});

describe("hashCommandBinary", () => {
  it("returns the same digest for the same file twice", () => {
    const f = join(tempDir, "stable.bin");
    writeFileSync(f, Buffer.from("hello world"));
    const a = hashCommandBinary(f);
    const b = hashCommandBinary(f);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns different digests for different file contents", () => {
    const f1 = join(tempDir, "a.bin");
    const f2 = join(tempDir, "b.bin");
    writeFileSync(f1, Buffer.from("alpha"));
    writeFileSync(f2, Buffer.from("beta"));
    expect(hashCommandBinary(f1)).not.toBe(hashCommandBinary(f2));
  });

  it("throws on a 0-byte file rather than returning the empty-string digest", () => {
    // SHA-256 of zero bytes is a known constant; returning it would let any
    // 0-byte file pass once trust-on-first-use stamped that constant in.
    const f = join(tempDir, "empty.bin");
    writeFileSync(f, Buffer.alloc(0));
    expect(() => hashCommandBinary(f)).toThrow(/empty or unreadable/);
  });

  it("caps the read at 4MB — changes BEYOND the cap do not alter the digest", () => {
    const cap = __HASH_READ_CAP_BYTES_FOR_TESTS;
    const f = join(tempDir, "big.bin");
    // First `cap` bytes identical, then a divergent suffix.
    const head = Buffer.alloc(cap, 0x41); // 'A' * cap
    const tailA = Buffer.from("PAYLOAD_A_PAYLOAD_A");
    const tailB = Buffer.from("PAYLOAD_B_PAYLOAD_B");
    writeFileSync(f, Buffer.concat([head, tailA]));
    const hashA = hashCommandBinary(f);
    writeFileSync(f, Buffer.concat([head, tailB]));
    const hashB = hashCommandBinary(f);
    expect(hashA).toBe(hashB);
  });
});

describe("trust store persistence", () => {
  it("round-trips a written entry through saveTrustStore / loadTrustStore", () => {
    const store = {
      "srv-x": { sha256: "abc123", firstSeenAt: 1700000000000, commandPath: "/some/path" },
    };
    saveTrustStore(store);
    const loaded = loadTrustStore();
    expect(loaded).toEqual(store);
  });

  it("returns {} when no trust store file exists", () => {
    expect(loadTrustStore()).toEqual({});
  });

  it.skipIf(process.platform === "win32")("writes the trust store with mode 0o600", () => {
    saveTrustStore({ a: { sha256: "x", firstSeenAt: 1, commandPath: "/x" } });
    const p = __trustStorePathForTests();
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("verifyOrTrust — first connect", () => {
  it("auto-accepts and writes the entry on first connect", () => {
    const bin = join(tempDir, "srv-a-bin");
    writeFileSync(bin, Buffer.from("server-a-v1"));
    const result = verifyOrTrust("srv-a", bin);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.firstTrust).toBe(true);
      expect(result.resolvedPath).toBe(bin);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const store = loadTrustStore();
    expect(store["srv-a"]).toBeDefined();
    expect(store["srv-a"].commandPath).toBe(bin);
  });

  it("returns ok with firstTrust=false on second connect with the same binary", () => {
    const bin = join(tempDir, "srv-a-bin");
    writeFileSync(bin, Buffer.from("server-a-v1"));
    verifyOrTrust("srv-a", bin);
    const result = verifyOrTrust("srv-a", bin);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.firstTrust).toBe(false);
    }
  });

  it("rejects first connect when LAX_MCP_STRICT_TRUST=1 and store has no entry", () => {
    process.env.LAX_MCP_STRICT_TRUST = "1";
    const bin = join(tempDir, "srv-a-bin");
    writeFileSync(bin, Buffer.from("server-a-v1"));
    const result = verifyOrTrust("srv-a", bin);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/strict-trust/);
    }
    expect(existsSync(__trustStorePathForTests())).toBe(false);
  });
});

describe("verifyOrTrust — tampering & re-trust", () => {
  it("detects a binary swap on a subsequent connect", () => {
    const bin = join(tempDir, "srv-a-bin");
    writeFileSync(bin, Buffer.from("server-a-v1"));
    verifyOrTrust("srv-a", bin);

    // Tamper within the 4MB cap so the hash actually changes.
    writeFileSync(bin, Buffer.from("server-a-v1-EVIL-SWAP"));
    const result = verifyOrTrust("srv-a", bin);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/hash changed/);
    }
  });

  it("LAX_MCP_RETRUST=<name> accepts the new hash and persists it", () => {
    const bin = join(tempDir, "srv-a-bin");
    writeFileSync(bin, Buffer.from("server-a-v1"));
    verifyOrTrust("srv-a", bin);
    const firstHash = loadTrustStore()["srv-a"].sha256;

    writeFileSync(bin, Buffer.from("server-a-v2-legit-upgrade"));
    process.env.LAX_MCP_RETRUST = "srv-a";
    const result = verifyOrTrust("srv-a", bin);
    expect(result.ok).toBe(true);

    const newHash = loadTrustStore()["srv-a"].sha256;
    expect(newHash).not.toBe(firstHash);
    if (result.ok) {
      expect(result.sha256).toBe(newHash);
    }
  });
});

describe("verifyOrTrust — command not found", () => {
  it("returns ok:false with a 'command not found' reason", () => {
    const result = verifyOrTrust("srv-missing", "definitely_not_a_real_binary_xyz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/command not found/);
    }
  });
});

describe("verifyOrTrust — unhashable binary", () => {
  it("returns ok:false on a 0-byte binary without stamping a trust entry", () => {
    const bin = join(tempDir, "srv-empty-bin");
    writeFileSync(bin, Buffer.alloc(0));
    const result = verifyOrTrust("srv-empty", bin);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/could not hash binary/);
      expect(result.reason).toMatch(/empty or unreadable/);
    }
    // Critically: no trust-store entry was written, so a later non-empty
    // binary at the same name still hits the first-trust path correctly.
    expect(existsSync(__trustStorePathForTests())).toBe(false);
  });
});

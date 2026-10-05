// The file-fallback master key is derived with scrypt at ~256 MB, synchronously.
// Every call used to derive it again, freezing the event loop for seconds each
// time; on a loaded CI runner that timed out the test teardown after it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { derivations } = vi.hoisted(() => ({ derivations: { count: 0 } }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    scryptSync: (...args: Parameters<typeof actual.scryptSync>) => { derivations.count += 1; return actual.scryptSync(...args); },
  };
});

import { getOrCreateMasterKey } from "./keychain.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("the file-fallback master key", () => {
  it("is derived once per process and returned the same every time", () => {
    process.env.LAX_DISABLE_OS_KEYCHAIN = "1";
    const dir = mkdtempSync(join(tmpdir(), "lax-keychain-cache-"));
    dirs.push(dir);
    derivations.count = 0;
    const first = getOrCreateMasterKey(dir).key;
    const second = getOrCreateMasterKey(dir).key;
    expect(derivations.count).toBe(1);
    expect(second.equals(first)).toBe(true);
  });

  it("hands out copies: a caller wiping its key does not wipe the cache", () => {
    process.env.LAX_DISABLE_OS_KEYCHAIN = "1";
    const dir = mkdtempSync(join(tmpdir(), "lax-keychain-cache-"));
    dirs.push(dir);
    const original = Buffer.from(getOrCreateMasterKey(dir).key);
    getOrCreateMasterKey(dir).key.fill(0);
    expect(getOrCreateMasterKey(dir).key.equals(original)).toBe(true);
  });
});

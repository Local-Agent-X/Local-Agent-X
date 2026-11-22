// The trust ledger lives in the data dir. With LAX_DATA_DIR set it used to stay
// in <home>/.lax — outside the control-file protection, which guards the data
// dir's copy.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as ledger from "./trust-ledger.js";

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lax-ledger-data-"));
  process.env.LAX_DATA_DIR = dataDir;
  ledger._resetLedgerCacheForTests();
});

afterEach(() => {
  delete process.env.LAX_DATA_DIR;
  ledger._resetLedgerCacheForTests();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("trust ledger location", () => {
  it("is written in a relocated data dir, not under the home folder", () => {
    const fp = ledger.fingerprintOf("shell", "https://example.com/upload");
    expect(fp).not.toBeNull();
    ledger.recordApproval(fp!, "test");
    expect(existsSync(join(dataDir, "threat-trust-ledger.json"))).toBe(true);
    expect(existsSync(join(homedir(), ".lax", "threat-trust-ledger.json"))).toBe(false);
  });

  it("is read back from the data dir", () => {
    const fp = ledger.fingerprintOf("shell", "https://example.com/upload")!;
    ledger.recordApproval(fp, "test");
    ledger._resetLedgerCacheForTests();
    expect(ledger.isLearned(fp)).toBe(true);
  });
});

// The app audit log's hash chain: every field of an entry, `details`
// included, is under its MAC; a trimmed log still verifies from the first
// entry it kept; and a log that cannot be read is set aside, not overwritten.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "app-audit-"));
vi.mock("./paths.js", () => ({
  AUDIT_DIR: join(root, "_audit"),
  auditPath: (id: string) => join(root, id, "audit.json"),
}));

const { writeAuditEntry } = await import("./audit.js");
const { _resetAuditKeyCacheForTests, signAuditEntry, verifyAuditChain } = await import("./audit-signing.js");
import type { AuditEntry } from "./types.js";

beforeAll(() => {
  process.env.LAX_AUDIT_KEY = "test-audit-key";
  _resetAuditKeyCacheForTests();
  mkdirSync(join(root, "_audit"), { recursive: true });
  mkdirSync(join(root, "app1"), { recursive: true });
});
afterAll(() => {
  delete process.env.LAX_AUDIT_KEY;
  _resetAuditKeyCacheForTests();
  rmSync(root, { recursive: true, force: true });
});

const readLog = (id: string): AuditEntry[] => JSON.parse(readFileSync(join(root, id, "audit.json"), "utf-8"));

describe("the app audit chain", () => {
  it("verifies as written, with a full-length MAC", () => {
    writeAuditEntry("app1", "user", "app:create", { name: "Calendar" });
    writeAuditEntry("app1", "agent-1", "app:update", { fields: ["title"] });
    const log = readLog("app1");
    expect(log[1].signature).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyAuditChain(log)).toEqual({ valid: true, startsAtGenesis: true });
  });

  it("an edit to an entry's details breaks it", () => {
    const log = readLog("app1");
    log[0].details = { name: "Something else" };
    expect(verifyAuditChain(log)).toMatchObject({ valid: false, brokenAt: 0, reason: "signature mismatch" });
  });

  it("a trimmed log verifies from the first entry it kept", () => {
    writeAuditEntry("app1", "user", "app:suspend", {});
    const kept = readLog("app1").slice(1);
    expect(verifyAuditChain(kept)).toEqual({ valid: true, startsAtGenesis: false });
    kept[0].prevHash = "f".repeat(64);
    expect(verifyAuditChain(kept).valid).toBe(false);
  });

  it("an entry signed without its details is named as such", () => {
    const entry = { id: "a", timestamp: 1, actor: "user", action: "x", appId: "app1", details: {}, prevHash: "genesis" };
    expect(verifyAuditChain([{ ...entry, signature: signAuditEntry(entry).slice(0, 16) }]))
      .toMatchObject({ valid: false, reason: "signed before the MAC covered its details" });
  });

  it("a log that cannot be read is kept aside and a new chain starts", () => {
    mkdirSync(join(root, "app2"), { recursive: true });
    writeFileSync(join(root, "app2", "audit.json"), "{ not json");
    writeAuditEntry("app2", "user", "app:create", {});
    const files = readdirSync(join(root, "app2"));
    const aside = files.find((f) => f.startsWith("audit.json.unreadable-"));
    expect(aside).toBeDefined();
    expect(readFileSync(join(root, "app2", aside!), "utf-8")).toBe("{ not json");
    expect(existsSync(join(root, "app2", "audit.json"))).toBe(true);
    expect(verifyAuditChain(readLog("app2"))).toEqual({ valid: true, startsAtGenesis: true });
  });
});

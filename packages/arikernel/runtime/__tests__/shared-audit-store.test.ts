import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditStore, verifyDatabaseChain } from "@arikernel/audit-log";
import { createFirewall } from "../src/index.js";

describe("shared audit store", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("keeps concurrent firewall runs on one valid hash chain", () => {
    dir = mkdtempSync(join(tmpdir(), "ari-shared-audit-"));
    const store = new AuditStore(join(dir, "audit.db"));
    try {
      const make = (name: string) => createFirewall({
        principal: { name, capabilities: [] },
        policies: [],
        auditStore: store,
        mode: "embedded",
      });
      const a = make("scope-a");
      const b = make("scope-b");

      a.audit({ toolClass: "internal", action: "a", parameters: {} });
      b.audit({ toolClass: "internal", action: "b", parameters: {} });
      a.audit({ toolClass: "internal", action: "a2", parameters: {} });

      a.close();
      b.close();
      const verification = verifyDatabaseChain(store);
      expect(verification.valid, JSON.stringify(verification, null, 2)).toBe(true);
      expect(a.replay()?.integrity.valid).toBe(true);
      expect(b.replay()?.integrity.valid).toBe(true);
      expect(() => store.listRuns()).not.toThrow();
    } finally {
      store.close();
    }
  });
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateRollbackTransaction } from "./update-rollback.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lax-update-rollback-"));
  roots.push(root);
  const install = join(root, "install");
  const state = join(root, "state");
  mkdirSync(join(install, "src"), { recursive: true });
  writeFileSync(join(install, "src", "app.ts"), "old");
  return { root, install, state };
}

describe("update rollback transaction", () => {
  it("restores overwritten files and removes newly introduced files", async () => {
    const f = fixture();
    const tx = new UpdateRollbackTransaction(f.state);
    await tx.begin(f.install, "a".repeat(40), "b".repeat(40), [join("src", "app.ts"), join("src", "new.ts")]);
    writeFileSync(join(f.install, "src", "app.ts"), "new");
    writeFileSync(join(f.install, "src", "new.ts"), "new-only");
    await tx.markApplied("b".repeat(40));
    await tx.restore(f.install, "b".repeat(40), "verification failed");
    expect(readFileSync(join(f.install, "src", "app.ts"), "utf-8")).toBe("old");
    expect(() => readFileSync(join(f.install, "src", "new.ts"))).toThrow();
    expect(JSON.parse(readFileSync(join(f.state, "update-rollback-report.json"), "utf-8"))).toMatchObject({
      status: "restored", reason: "verification failed", previousVersion: "a".repeat(40), targetVersion: "b".repeat(40),
    });
  });

  it("refuses target selection drift without changing files", async () => {
    const f = fixture();
    const tx = new UpdateRollbackTransaction(f.state);
    await tx.begin(f.install, "a".repeat(40), "b".repeat(40), [join("src", "app.ts")]);
    writeFileSync(join(f.install, "src", "app.ts"), "selected-b");
    await expect(tx.restore(f.install, "c".repeat(40), "wrong selection")).rejects.toThrow(/target identity/);
    expect(readFileSync(join(f.install, "src", "app.ts"), "utf-8")).toBe("selected-b");
  });

  it("fails closed on corrupt backup bytes", async () => {
    const f = fixture();
    const tx = new UpdateRollbackTransaction(f.state);
    const path = join("src", "app.ts");
    await tx.begin(f.install, "a".repeat(40), "b".repeat(40), [path]);
    writeFileSync(join(f.install, path), "new");
    writeFileSync(join(tx.backupRoot, path), "forged");
    await expect(tx.restore(f.install, "b".repeat(40), "failed")).rejects.toThrow(/integrity/);
    expect(readFileSync(join(f.install, path), "utf-8")).toBe("new");
  });

  it("fails closed on corrupt journal provenance", async () => {
    const f = fixture();
    const tx = new UpdateRollbackTransaction(f.state);
    mkdirSync(tx.directory, { recursive: true });
    writeFileSync(tx.journalPath, JSON.stringify({ version: 1, status: "active", installRoot: f.install,
      previousVersion: "a", targetVersion: "b", entries: [{ path: "..\\escape", existed: false, sha256: null }] }));
    await expect(tx.read()).rejects.toThrow(/ambiguous provenance/);
  });

  it("preserves a verified update across cleanup interruption", async () => {
    const f = fixture();
    const tx = new UpdateRollbackTransaction(f.state, (point) => {
      if (point === "after-verified") throw new Error("kill");
    });
    await tx.begin(f.install, "a".repeat(40), "b".repeat(40), [join("src", "app.ts")]);
    writeFileSync(join(f.install, "src", "app.ts"), "verified-new");
    await tx.markApplied("b".repeat(40));
    await expect(tx.markVerified("b".repeat(40))).rejects.toThrow("kill");
    expect((await new UpdateRollbackTransaction(f.state).read())?.status).toBe("verified");
    expect(readFileSync(join(f.install, "src", "app.ts"), "utf-8")).toBe("verified-new");
  });

  it("resumes a restore interrupted after publication without rolling back twice", async () => {
    const f = fixture();
    const target = "b".repeat(40);
    const first = new UpdateRollbackTransaction(f.state, (point) => {
      if (point === "after-restore") throw new Error("kill");
    });
    await first.begin(f.install, "a".repeat(40), target, [join("src", "app.ts")]);
    writeFileSync(join(f.install, "src", "app.ts"), "new");
    await expect(first.restore(f.install, target, "failed")).rejects.toThrow("kill");
    const second = new UpdateRollbackTransaction(f.state);
    expect((await second.restore(f.install, target, "retry")).status).toBe("restored");
    expect(readFileSync(join(f.install, "src", "app.ts"), "utf-8")).toBe("old");
  });

  it("keeps the journal durable when killed immediately after backup", async () => {
    const f = fixture();
    const tx = new UpdateRollbackTransaction(f.state, (point) => {
      if (point === "after-backup") throw new Error("kill");
    });
    await expect(tx.begin(f.install, "a".repeat(40), "b".repeat(40), [join("src", "app.ts")])).rejects.toThrow("kill");
    expect((await new UpdateRollbackTransaction(f.state).read())?.status).toBe("active");
  });

  it("recovers a kill during backup without treating an incomplete backup as restorable", async () => {
    const f = fixture();
    const target = "b".repeat(40);
    const tx = new UpdateRollbackTransaction(f.state, (point) => {
      if (point.startsWith("after-backup-entry:")) throw new Error("kill");
    });
    await expect(tx.begin(f.install, "a".repeat(40), target, [join("src", "app.ts")])).rejects.toThrow("kill");
    const resumed = new UpdateRollbackTransaction(f.state);
    expect((await resumed.read())?.status).toBe("backing-up");
    expect((await resumed.restore(f.install, target, "interrupted backup")).status).toBe("restored");
    expect(readFileSync(join(f.install, "src", "app.ts"), "utf-8")).toBe("old");
  });
});

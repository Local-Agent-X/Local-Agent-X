import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateRollbackTransaction } from "./update-rollback.js";
import { CAN_CREATE_DIRECTORY_LINK } from "./symlink-capabilities.test-helper.js";

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

  it("refuses a valid journal copied into an attacker-controlled state root", async () => {
    const f = fixture();
    const original = new UpdateRollbackTransaction(f.state);
    const target = "b".repeat(40);
    const introduced = join("src", "introduced.ts");
    await original.begin(f.install, "a".repeat(40), target, [join("src", "app.ts"), introduced]);
    writeFileSync(join(f.install, "src", "app.ts"), "must-survive");
    writeFileSync(join(f.install, introduced), "must-not-be-deleted");
    const forgedState = join(f.root, "forged-state");
    const forged = new UpdateRollbackTransaction(forgedState);
    mkdirSync(forged.directory, { recursive: true });
    writeFileSync(forged.journalPath, readFileSync(original.journalPath));

    await expect(forged.restore(f.install, target, "forged state")).rejects.toThrow(/ambiguous provenance/);
    expect(readFileSync(join(f.install, "src", "app.ts"), "utf-8")).toBe("must-survive");
    expect(readFileSync(join(f.install, introduced), "utf-8")).toBe("must-not-be-deleted");
  });

  it("refuses paths that collide under Windows case-folding semantics", async () => {
    const f = fixture();
    const tx = new UpdateRollbackTransaction(f.state);
    await expect(tx.begin(f.install, "old", "new", [join("src", "app.ts"), join("SRC", "APP.ts")]))
      .rejects.toThrow(/collide/);
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("refuses a linked target chain before restoring", async () => {
    const f = fixture();
    const tx = new UpdateRollbackTransaction(f.state);
    const target = "b".repeat(40);
    await tx.begin(f.install, "a".repeat(40), target, [join("src", "app.ts")]);
    const outside = join(f.root, "outside-target");
    mkdirSync(outside);
    writeFileSync(join(outside, "app.ts"), "outside");
    rmSync(join(f.install, "src"), { recursive: true });
    symlinkSync(outside, join(f.install, "src"), process.platform === "win32" ? "junction" : "dir");

    await expect(tx.restore(f.install, target, "linked target")).rejects.toThrow(/linked|escaped/);
    expect(readFileSync(join(outside, "app.ts"), "utf-8")).toBe("outside");
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("refuses a linked backup chain before restoring", async () => {
    const f = fixture();
    const tx = new UpdateRollbackTransaction(f.state);
    const target = "b".repeat(40);
    await tx.begin(f.install, "a".repeat(40), target, [join("src", "app.ts")]);
    writeFileSync(join(f.install, "src", "app.ts"), "new");
    const outside = join(f.root, "outside-backup");
    mkdirSync(outside);
    writeFileSync(join(outside, "app.ts"), "outside");
    rmSync(join(tx.backupRoot, "src"), { recursive: true });
    symlinkSync(outside, join(tx.backupRoot, "src"), process.platform === "win32" ? "junction" : "dir");

    await expect(tx.restore(f.install, target, "linked backup")).rejects.toThrow(/linked|escaped/);
    expect(readFileSync(join(f.install, "src", "app.ts"), "utf-8")).toBe("new");
  });

  it("refuses a replaced trusted install base", async () => {
    const f = fixture();
    const tx = new UpdateRollbackTransaction(f.state);
    const target = "b".repeat(40);
    await tx.begin(f.install, "a".repeat(40), target, [join("src", "app.ts")]);
    const displaced = join(f.root, "displaced-install");
    renameSync(f.install, displaced);
    mkdirSync(join(f.install, "src"), { recursive: true });
    writeFileSync(join(f.install, "src", "app.ts"), "replacement");

    await expect(tx.restore(f.install, target, "base replaced")).rejects.toThrow(/ambiguous provenance/);
    expect(readFileSync(join(f.install, "src", "app.ts"), "utf-8")).toBe("replacement");
  });

  it("resumes a restore interrupted between entry publications", async () => {
    const f = fixture();
    const target = "b".repeat(40);
    const added = join("src", "new.ts");
    const first = new UpdateRollbackTransaction(f.state, (point) => {
      if (point.startsWith("after-restore-entry:")) throw new Error("kill");
    });
    await first.begin(f.install, "a".repeat(40), target, [join("src", "app.ts"), added]);
    writeFileSync(join(f.install, "src", "app.ts"), "new");
    writeFileSync(join(f.install, added), "added");
    await expect(first.restore(f.install, target, "failed")).rejects.toThrow("kill");

    const resumed = new UpdateRollbackTransaction(f.state);
    await expect(resumed.restore(f.install, target, "retry")).resolves.toMatchObject({ status: "restored" });
    expect(readFileSync(join(f.install, "src", "app.ts"), "utf-8")).toBe("old");
    expect(existsSync(join(f.install, added))).toBe(false);
  });
});

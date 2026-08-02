import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  markHistoryRolledBack, readInstalledCommit, readUpdateHistory, upsertAppliedHistory, writeInstalledCommit,
} from "./ota-update-state.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function path(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "lax-ota-state-"));
  roots.push(root);
  return join(root, name);
}

// Invariant: state that exists only to inform the updater must never be able to
// BRICK it. A corrupt/garbage/missing file reads as "absent" (null / []), never
// throws — otherwise a single bad write halts all future updates. This is the
// same failure class as the 2026-07 rollback-journal wedge, locked in here for
// the other update-path readers so a refactor can't silently reintroduce it.
describe("OTA state readers tolerate corruption (never brick the updater)", () => {
  for (const bad of ["{ not json", "null", "42", "\"a string\"", "{}", "[1,2,3]", ""]) {
    it(`readInstalledCommit → null on ${JSON.stringify(bad)}`, async () => {
      const p = path("installed-source.json");
      writeFileSync(p, bad);
      await expect(readInstalledCommit(p)).resolves.toBeNull();
    });
  }
  it("readInstalledCommit → null when the file is missing", async () => {
    await expect(readInstalledCommit(path("nope.json"))).resolves.toBeNull();
  });
  for (const bad of ["{ not json", "null", "42", "{\"not\":\"array\"}", ""]) {
    it(`readUpdateHistory → [] on ${JSON.stringify(bad)}`, async () => {
      const p = path("history.json");
      writeFileSync(p, bad);
      await expect(readUpdateHistory(p)).resolves.toEqual([]);
    });
  }
  it("readUpdateHistory → [] when the file is missing", async () => {
    await expect(readUpdateHistory(path("nope.json"))).resolves.toEqual([]);
  });
});

describe("OTA publication state", () => {
  it("upserts an applied transaction without duplicating history on recovery", async () => {
    const historyPath = path("history.json");
    const entry = {
      version: "release", appliedAt: "2026-07-21T00:00:00.000Z", status: "applied" as const,
      previousVersion: "a", targetVersion: "b", transactionId: "tx-1",
    };
    await upsertAppliedHistory(historyPath, entry);
    await upsertAppliedHistory(historyPath, { ...entry, appliedAt: "2026-07-21T00:00:01.000Z" });
    expect(await readUpdateHistory(historyPath)).toEqual([{ ...entry, appliedAt: "2026-07-21T00:00:01.000Z" }]);
  });

  it("marks the matching transaction rolled back idempotently", async () => {
    const historyPath = path("history.json");
    await upsertAppliedHistory(historyPath, {
      version: "release", appliedAt: "now", status: "applied", previousVersion: "a",
      targetVersion: "b", transactionId: "tx-1",
    });
    await markHistoryRolledBack(historyPath, "tx-1", "a", "b");
    await markHistoryRolledBack(historyPath, "tx-1", "a", "b");
    expect(await readUpdateHistory(historyPath)).toMatchObject([{ transactionId: "tx-1", status: "rolled-back" }]);
  });

  it("publishes installed commits through an atomic replacement", async () => {
    const marker = path("installed.json");
    await writeInstalledCommit(marker, "first");
    await writeInstalledCommit(marker, "second");
    expect(JSON.parse(readFileSync(marker, "utf-8"))).toMatchObject({ commit: "second" });
  });
});

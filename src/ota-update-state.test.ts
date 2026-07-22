import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  markHistoryRolledBack, readUpdateHistory, upsertAppliedHistory, writeInstalledCommit,
} from "./ota-update-state.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function path(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "lax-ota-state-"));
  roots.push(root);
  return join(root, name);
}

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

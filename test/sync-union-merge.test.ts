/**
 * Pins the union-merge contract used by agent-projects.json pull (and any
 * future record-array pull sharing the same shape).
 *
 * The original pull was destructive last-write-wins on the remote sync-repo
 * file — any locally-newer record was silently overwritten. Repro: a project
 * created on this machine that hadn't been pushed yet got wiped the next
 * time pull ran against a stale sync-repo (Acme Springfield, 2026-05-22).
 *
 * Contract:
 *   - records present only on remote → keep
 *   - records present only on local → keep
 *   - records present on both → keep the one with the higher updatedAt
 *   - missing or non-numeric updatedAt is treated as 0
 */

import { describe, it, expect } from "vitest";
import { unionMergeRecordsById } from "../src/sync/pull-files.js";

interface Rec { id: string; updatedAt?: number; payload?: string }

describe("unionMergeRecordsById", () => {
  it("keeps a local-only record (the bug we just fixed)", () => {
    const local: Rec[] = [
      { id: "proj-A", updatedAt: 100, payload: "alpha" },
      { id: "proj-LOCAL-ONLY", updatedAt: 200, payload: "fresh" },
    ];
    const remote: Rec[] = [
      { id: "proj-A", updatedAt: 100, payload: "alpha" },
    ];
    const merged = unionMergeRecordsById(local, remote);
    expect(merged.find(r => r.id === "proj-LOCAL-ONLY")).toBeDefined();
    expect(merged.find(r => r.id === "proj-LOCAL-ONLY")?.payload).toBe("fresh");
  });

  it("keeps a remote-only record", () => {
    const local: Rec[] = [
      { id: "proj-A", updatedAt: 100 },
    ];
    const remote: Rec[] = [
      { id: "proj-A", updatedAt: 100 },
      { id: "proj-REMOTE-ONLY", updatedAt: 50 },
    ];
    const merged = unionMergeRecordsById(local, remote);
    expect(merged.find(r => r.id === "proj-REMOTE-ONLY")).toBeDefined();
  });

  it("picks the higher updatedAt on id collision", () => {
    const local: Rec[] = [{ id: "proj-A", updatedAt: 200, payload: "local-newer" }];
    const remote: Rec[] = [{ id: "proj-A", updatedAt: 100, payload: "remote-older" }];
    const merged = unionMergeRecordsById(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].payload).toBe("local-newer");
  });

  it("picks remote when remote is newer (the case the old code handled)", () => {
    const local: Rec[] = [{ id: "proj-A", updatedAt: 100, payload: "local-older" }];
    const remote: Rec[] = [{ id: "proj-A", updatedAt: 200, payload: "remote-newer" }];
    const merged = unionMergeRecordsById(local, remote);
    expect(merged[0].payload).toBe("remote-newer");
  });

  it("treats missing updatedAt as 0", () => {
    const local: Rec[] = [{ id: "proj-A", payload: "no-ts" }];
    const remote: Rec[] = [{ id: "proj-A", updatedAt: 1, payload: "with-ts" }];
    const merged = unionMergeRecordsById(local, remote);
    expect(merged[0].payload).toBe("with-ts");
  });

  it("empty inputs return empty", () => {
    expect(unionMergeRecordsById([], [])).toEqual([]);
  });

  it("local-only with empty remote keeps everything", () => {
    const local: Rec[] = [
      { id: "proj-A", updatedAt: 100 },
      { id: "proj-B", updatedAt: 200 },
    ];
    const merged = unionMergeRecordsById(local, []);
    expect(merged).toHaveLength(2);
  });
});

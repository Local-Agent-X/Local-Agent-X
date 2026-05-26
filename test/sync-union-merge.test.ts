/**
 * Pins the union-merge contract used by agent-projects.json pull (and any
 * future record-array pull sharing the same shape).
 *
 * The original pull was destructive last-write-wins on the remote sync-repo
 * file — any locally-newer record was silently overwritten. Repro: a project
 * created on this machine that hadn't been pushed yet got wiped the next
 * time pull ran against a stale sync-repo (2026-05-22 incident).
 *
 * Contract:
 *   - records present only on remote → keep
 *   - records present only on local → keep
 *   - records present on both → keep the one with the higher updatedAt
 *   - missing or non-numeric updatedAt is treated as 0
 */

import { describe, it, expect } from "vitest";
import { unionMergeRecordsById, unionMergeBy } from "../src/sync/pull-files.js";

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

// Generic unionMergeBy covers the snake_case (tasks), name-keyed
// (sidebar pins, custom missions), and no-timestamp (calendar events)
// cases. The wrapper above proves the common id+updatedAt path; these
// pin the variants.
describe("unionMergeBy — generic key + collision predicate", () => {
  interface Task { id: string; updated_at?: number; title?: string }
  interface Named { name: string; payload?: string }

  it("tasks.json shape: snake_case timestamp, local-newer wins", () => {
    const local: Task[] = [
      { id: "t-1", updated_at: 200, title: "local-newer" },
      { id: "t-LOCAL-ONLY", updated_at: 50, title: "fresh" },
    ];
    const remote: Task[] = [
      { id: "t-1", updated_at: 100, title: "remote-older" },
    ];
    const merged = unionMergeBy(local, remote, (x) => x.id, (l, r) => (Number(l.updated_at) || 0) > (Number(r.updated_at) || 0));
    expect(merged.find(t => t.id === "t-1")?.title).toBe("local-newer");
    expect(merged.find(t => t.id === "t-LOCAL-ONLY")).toBeDefined();
  });

  it("name-keyed without timestamp: local-only entry survives stale-remote pull", () => {
    const local: Named[] = [
      { name: "🚀 Naughty Toys", payload: "local-pin" },
    ];
    const remote: Named[] = [
      { name: "Mygroomtime", payload: "from-other-machine" },
    ];
    const merged = unionMergeBy(local, remote, (x) => x.name, () => true);
    expect(merged).toHaveLength(2);
    expect(merged.find(n => n.name === "🚀 Naughty Toys")).toBeDefined();
    expect(merged.find(n => n.name === "Mygroomtime")).toBeDefined();
  });

  it("name-keyed: local-wins-on-collision (local edit beats stale-remote)", () => {
    const local: Named[] = [{ name: "research-flow", payload: "local-edit" }];
    const remote: Named[] = [{ name: "research-flow", payload: "remote-stale" }];
    const merged = unionMergeBy(local, remote, (x) => x.name, () => true);
    expect(merged[0].payload).toBe("local-edit");
  });

  it("skips items with empty/falsy keys", () => {
    const local = [{ id: "" }, { id: "kept" }];
    const remote = [{ id: "from-remote" }];
    const merged = unionMergeBy(local, remote, (x) => x.id, () => true);
    expect(merged.map(m => m.id).sort()).toEqual(["from-remote", "kept"]);
  });
});

// mcp.json uses a different shape — {servers: Map<name, config>} rather
// than an array. The pull block uses object spread instead of unionMergeBy,
// but the contract is the same: union of keys, local-wins on collision.
// This pins the spread-merge expectation that the pull-files block relies on.
describe("mcp.json shape — spread-merge of server map", () => {
  it("union of keys, local wins on collision", () => {
    const local = { servers: { fs: { command: "fs-local" }, sql: { command: "sql-only-local" } } };
    const remote = { servers: { fs: { command: "fs-remote-stale" }, gh: { command: "gh-only-remote" } } };
    const merged = { ...remote, ...local, servers: { ...remote.servers, ...local.servers } };
    expect(Object.keys(merged.servers).sort()).toEqual(["fs", "gh", "sql"]);
    expect(merged.servers.fs.command).toBe("fs-local");
    expect(merged.servers.gh.command).toBe("gh-only-remote");
    expect(merged.servers.sql.command).toBe("sql-only-local");
  });
});

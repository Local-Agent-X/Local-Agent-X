/**
 * Pins the ProjectRosterStore contract — the per-(project, agent)
 * record that owns hire/reportsTo/heartbeat/budget post-L3.
 *
 * Core invariants:
 *   1. Same agentId in two projects → two independent entries with
 *      independent metadata. No global "hired" state.
 *   2. upsert is idempotent (calling twice produces one entry).
 *   3. listByProject / listByAgent / listRosteredAgentIds slice the
 *      same underlying map without leaking entries across views.
 *   4. remove returns true only when an entry was present.
 *
 * These are unit tests against the store. The end-to-end migration
 * from legacy AgentTemplate.hired data is verified manually on a real
 * install — there's no clean way to fixture both legacy files inside
 * a test, and the migration runs once at first boot.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ProjectRosterStore } from "../src/project-rosters.js";

const ROSTERS_FILE = join(homedir(), ".lax", "project-rosters.json");

let backupContents: string | null = null;

describe("ProjectRosterStore", () => {
  beforeEach(() => {
    // Back up the dev install's real data and replace with an EMPTY
    // map. Empty file is treated as "already migrated, nothing there"
    // — bypasses the legacy-template migration that would otherwise
    // pull in the user's seeded agents/projects and contaminate the
    // test fixture.
    backupContents = existsSync(ROSTERS_FILE) ? readFileSync(ROSTERS_FILE, "utf-8") : null;
    writeFileSync(ROSTERS_FILE, "{}", "utf-8");
    ProjectRosterStore._resetForTest();
  });

  afterEach(() => {
    if (backupContents !== null) writeFileSync(ROSTERS_FILE, backupContents, "utf-8");
    else if (existsSync(ROSTERS_FILE)) unlinkSync(ROSTERS_FILE);
    backupContents = null;
    ProjectRosterStore._resetForTest();
  });

  it("starts empty when no entries exist", () => {
    const store = ProjectRosterStore.getInstance();
    expect(store.listAll()).toEqual([]);
    expect(store.listRosteredAgentIds()).toEqual([]);
  });

  it("upsert creates an entry, returns it", () => {
    const store = ProjectRosterStore.getInstance();
    const entry = store.upsert("proj-A", "agent-X", { reportsTo: "agent-CEO" });
    expect(entry.projectId).toBe("proj-A");
    expect(entry.agentId).toBe("agent-X");
    expect(entry.reportsTo).toBe("agent-CEO");
    expect(entry.createdAt).toBeGreaterThan(0);
  });

  it("upsert is idempotent — second call patches, doesn't duplicate", () => {
    const store = ProjectRosterStore.getInstance();
    const first = store.upsert("proj-A", "agent-X", { reportsTo: "agent-CEO" });
    const second = store.upsert("proj-A", "agent-X", { reportsTo: "agent-CTO" });
    expect(store.listAll()).toHaveLength(1);
    expect(second.reportsTo).toBe("agent-CTO");
    expect(second.createdAt).toBe(first.createdAt); // preserves create time
  });

  it("same agent in two projects gets two independent entries", () => {
    const store = ProjectRosterStore.getInstance();
    store.upsert("proj-A", "agent-X", { reportsTo: "manager-1" });
    store.upsert("proj-B", "agent-X", { reportsTo: "manager-2", heartbeatSchedule: "every 1h" });
    const all = store.listByAgent("agent-X");
    expect(all).toHaveLength(2);
    const a = all.find((r) => r.projectId === "proj-A");
    const b = all.find((r) => r.projectId === "proj-B");
    expect(a?.reportsTo).toBe("manager-1");
    expect(b?.reportsTo).toBe("manager-2");
    expect(a?.heartbeatEnabled).toBeFalsy();
    expect(b?.heartbeatEnabled).toBe(true);
  });

  it("heartbeatEnabled is auto-set when heartbeatSchedule is provided", () => {
    const store = ProjectRosterStore.getInstance();
    const entry = store.upsert("proj-A", "agent-X", { heartbeatSchedule: "every 4h" });
    expect(entry.heartbeatEnabled).toBe(true);
    expect(entry.heartbeatSchedule).toBe("every 4h");
  });

  it("listByProject returns only that project's entries", () => {
    const store = ProjectRosterStore.getInstance();
    store.upsert("proj-A", "agent-X");
    store.upsert("proj-A", "agent-Y");
    store.upsert("proj-B", "agent-X");
    const a = store.listByProject("proj-A");
    expect(a).toHaveLength(2);
    expect(a.map((r) => r.agentId).sort()).toEqual(["agent-X", "agent-Y"]);
  });

  it("listRosteredAgentIds dedupes across projects", () => {
    const store = ProjectRosterStore.getInstance();
    store.upsert("proj-A", "agent-X");
    store.upsert("proj-B", "agent-X");
    store.upsert("proj-A", "agent-Y");
    const ids = store.listRosteredAgentIds().sort();
    expect(ids).toEqual(["agent-X", "agent-Y"]);
  });

  it("patch updates fields on an existing entry; returns null when missing", () => {
    const store = ProjectRosterStore.getInstance();
    store.upsert("proj-A", "agent-X", { reportsTo: "manager-1" });
    const updated = store.patch("proj-A", "agent-X", { reportsTo: "manager-2", heartbeatSchedule: "daily 9am" });
    expect(updated?.reportsTo).toBe("manager-2");
    expect(updated?.heartbeatSchedule).toBe("daily 9am");
    expect(store.patch("proj-A", "ghost-agent", { reportsTo: "x" })).toBeNull();
  });

  it("remove returns true only when an entry existed", () => {
    const store = ProjectRosterStore.getInstance();
    store.upsert("proj-A", "agent-X");
    expect(store.remove("proj-A", "agent-X")).toBe(true);
    expect(store.remove("proj-A", "agent-X")).toBe(false);
    expect(store.listByProject("proj-A")).toEqual([]);
  });

  it("persists across instances — write, reset singleton, read back", () => {
    ProjectRosterStore.getInstance().upsert("proj-A", "agent-X", { reportsTo: "CEO" });
    ProjectRosterStore._resetForTest();
    const fresh = ProjectRosterStore.getInstance();
    const entry = fresh.get("proj-A", "agent-X");
    expect(entry).toBeDefined();
    expect(entry?.reportsTo).toBe("CEO");
  });
});

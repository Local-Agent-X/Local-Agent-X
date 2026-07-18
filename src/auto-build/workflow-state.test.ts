import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppBuildWorkflowStore } from "./workflow-state.js";

const dirs: string[] = [];

function makeStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "app-build-workflow-"));
  dirs.push(dir);
  return join(dir, "workflows.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("app-build workflow state", () => {
  it("persists planning state across store reload and supports session lookup", () => {
    const filePath = makeStorePath();
    const first = createAppBuildWorkflowStore(filePath);
    first.upsert({ sessionId: "session-planning", phase: "planning" });

    const reloaded = createAppBuildWorkflowStore(filePath);
    expect(reloaded.read("session-planning")).toMatchObject({
      kind: "app-build",
      sessionId: "session-planning",
      phase: "planning",
    });
    expect(reloaded.read("another-session")).toBeNull();
  });

  it("persists finalized project state and supports project queries", () => {
    const filePath = makeStorePath();
    const first = createAppBuildWorkflowStore(filePath);
    first.upsert({ sessionId: "session-finalized", phase: "planning" });
    first.update("session-finalized", {
      phase: "finalized",
      projectDir: "C:\\projects\\calendar",
    });

    const reloaded = createAppBuildWorkflowStore(filePath);
    expect(reloaded.query({ projectDir: "C:\\projects\\calendar" })).toHaveLength(1);
    expect(reloaded.read("session-finalized")).toMatchObject({
      phase: "finalized",
      projectDir: "C:\\projects\\calendar",
    });
  });

  it("returns an empty store for missing and malformed files", () => {
    const filePath = makeStorePath();
    const store = createAppBuildWorkflowStore(filePath);
    expect(store.query()).toEqual([]);

    writeFileSync(filePath, "{not-json", "utf-8");
    expect(createAppBuildWorkflowStore(filePath).query()).toEqual([]);

    writeFileSync(filePath, JSON.stringify({
      version: 1,
      workflows: [{
        kind: "app-build",
        sessionId: "session-with-bad-timestamps",
        phase: "planning",
        createdAt: "not-a-date",
        updatedAt: "not-a-date",
      }],
    }), "utf-8");
    expect(createAppBuildWorkflowStore(filePath).query()).toEqual([]);
  });

  it("updates, queries, and clears a workflow without disturbing other sessions", () => {
    const filePath = makeStorePath();
    const store = createAppBuildWorkflowStore(filePath);
    store.upsert({ sessionId: "one", phase: "planning" });
    store.upsert({ sessionId: "two", phase: "running", opId: "op-2" });

    expect(store.query({ phase: "running" }).map(record => record.sessionId)).toEqual(["two"]);
    expect(store.query({ opId: "op-2" })).toHaveLength(1);
    expect(store.clear("one")).toBe(true);
    expect(store.clear("one")).toBe(false);
    expect(store.read("two")?.opId).toBe("op-2");

    const persisted = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(persisted.workflows).toHaveLength(1);
  });
});

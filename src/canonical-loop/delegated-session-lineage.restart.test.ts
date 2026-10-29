// A worker restored after a restart rebinds to its parent chat before anyone
// opens that chat again. The session→project map lived only in memory, so the
// worker came back with no project and its memory search no longer reached
// the project's documents.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../memory/session-store.js";
import { bindDelegatedSessionLineage } from "./delegated-session-lineage.js";
import { clearSessionOwner } from "../browser/session-owner-registry.js";
import { _resetSessionProjectsForTest, getSessionProject, seedSessionProjects } from "../session/project.js";

const dirs: string[] = [];
afterEach(() => {
  _resetSessionProjectsForTest();
  clearSessionOwner("op_restored_worker");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the session→project map after a restart", () => {
  it("is seeded from the saved sessions, so a restored worker gets its parent chat's project", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lax-session-project-"));
    dirs.push(dataDir);
    const now = Date.now();
    new SessionStore(dataDir).save({ id: "chat-in-project", title: "Acme", messages: [], createdAt: now, updatedAt: now, projectId: "proj-acme" });
    new SessionStore(dataDir).save({ id: "chat-loose", title: "Other", messages: [], createdAt: now, updatedAt: now });
    _resetSessionProjectsForTest();

    seedSessionProjects(new SessionStore(dataDir).list());
    bindDelegatedSessionLineage("op_restored_worker", "chat-in-project");

    expect(getSessionProject("chat-in-project")).toBe("proj-acme");
    expect(getSessionProject("op_restored_worker")).toBe("proj-acme");
    expect(getSessionProject("chat-loose")).toBeUndefined();
  });
});

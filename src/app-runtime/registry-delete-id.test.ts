// app_delete and DELETE /api/apps/:id both key every step on the id: the
// dev-server record, the registry dir, and the workspace folder it moves to
// the trash. An id of "", "." or "x/.." resolved to the apps folder itself
// and "../x" to a sibling, so one call could trash every app (red team
// 2026-10-13, B5). The id is judged before anything runs.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppRegistry } from "./registry.js";
import { appDir } from "./paths.js";
import { getLaxDir } from "../lax-data-dir.js";

describe("an app id names one folder under apps/", () => {
  const registry = AppRegistry.getInstance();

  it("refuses an id that is not a single folder name, before any side effect", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "lax-app-delete-"));
    try {
      for (const id of ["", ".", "..", "x/..", "../apps-foo", "a/b", "a\\b"]) {
        const result = await registry.delete(id, "user", { workspaceDir });
        expect(result.deleted, JSON.stringify(id)).toBe(false);
        expect(result.error, JSON.stringify(id)).toMatch(/^Invalid app id/);
      }
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  // app_delete is classed recoverable (the irreversible floor does not card it)
  // because BOTH halves go to the recycle bin: the files and the app's stored
  // definition, state and events. The stored half used to be rmSync'd.
  it("a delete recycles the app's stored state as well as its files, so it can be undone", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "lax-app-delete-"));
    const id = `recyclable-${Date.now()}`;
    try {
      const now = Date.now();
      const created = registry.create({
        id, name: "Recyclable", description: "", components: [], dataBindings: [], actions: [], events: [],
        layout: { type: "stack" }, status: "active", version: 1, createdAt: now, updatedAt: now,
        permissions: { owner: "user", visibility: "private", allowedAgents: [], accessLevels: {} },
      }, "user");
      expect(created.error).toBeUndefined();
      registry.setState(id, { values: { note: "keep me" } } as never);
      expect(existsSync(appDir(id))).toBe(true);

      const result = await registry.delete(id, "user", { workspaceDir });
      expect(result).toMatchObject({ deleted: true, registry: true });
      expect(existsSync(appDir(id))).toBe(false);
      const trash = join(getLaxDir(), "trash");
      const kept = readdirSync(trash, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name === "definition.json" && join(e.parentPath ?? "", e.name).includes(id));
      expect(kept).toHaveLength(1);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("a folder name a person chose by hand is still an app to delete", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "lax-app-delete-"));
    try {
      const result = await registry.delete("my.notes-app", "user", { workspaceDir });
      expect(result.error).toBe("App not found");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

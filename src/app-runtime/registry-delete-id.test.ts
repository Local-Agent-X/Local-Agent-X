// app_delete and DELETE /api/apps/:id both key every step on the id: the
// dev-server record, the registry dir, and the workspace folder it moves to
// the trash. An id of "", "." or "x/.." resolved to the apps folder itself
// and "../x" to a sibling, so one call could trash every app (red team
// 2026-10-13, B5). The id is judged before anything runs.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppRegistry } from "./registry.js";

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

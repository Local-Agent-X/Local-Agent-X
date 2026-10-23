import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const projects = new Map<string, { workspace?: string }>();
vi.mock("../agent-store/project-store.js", () => ({
  ProjectStore: { getInstance: () => ({ get: (id: string) => projects.get(id) ?? null }) },
}));

const { codeSessionFolder, stampCodeSessionWorkRoot } = await import("./code-work-root.js");
const { sessionWorkRootOf, clearSessionWorkRoot } = await import("../workspace/paths.js");

describe("codeSessionFolder", () => {
  it("is the project's folder when it is a real directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-code-folder-"));
    expect(codeSessionFolder(dir)).toBe(dir);
  });

  it("is nothing for no folder, a missing one, or a file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "lax-code-folder-")), "f.txt");
    writeFileSync(file, "x");
    for (const named of [undefined, "", "  ", join(tmpdir(), "lax-no-such-folder-xyz"), file]) {
      expect(codeSessionFolder(named), String(named)).toBeUndefined();
    }
  });
});

describe("stampCodeSessionWorkRoot", () => {
  it("anchors a code session at its project's folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-code-folder-"));
    projects.set("p1", { workspace: dir });
    expect(stampCodeSessionWorkRoot({ id: "chat-c1", mode: "code", projectId: "p1" })).toBe(dir);
    expect(sessionWorkRootOf("chat-c1")).toBeTruthy();
    clearSessionWorkRoot("chat-c1");
  });

  it("leaves a chat, an App IDE session and a code session without a project folder alone", () => {
    projects.set("p2", { workspace: mkdtempSync(join(tmpdir(), "lax-code-folder-")) });
    projects.set("p3", {});
    expect(stampCodeSessionWorkRoot({ id: "chat-x", projectId: "p2" })).toBeUndefined();
    expect(stampCodeSessionWorkRoot({ id: "ide-todo", mode: "code", projectId: "p2" })).toBeUndefined();
    expect(stampCodeSessionWorkRoot({ id: "chat-y", mode: "code", projectId: "p3" })).toBeUndefined();
    expect(stampCodeSessionWorkRoot({ id: "chat-z", mode: "code" })).toBeUndefined();
    for (const id of ["chat-x", "ide-todo", "chat-y", "chat-z"]) expect(sessionWorkRootOf(id)).toBeUndefined();
  });
});

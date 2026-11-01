import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const projects = new Map<string, { workspace?: string }>();
vi.mock("../agent-store/project-store.js", () => ({
  ProjectStore: { getInstance: () => ({ get: (id: string) => projects.get(id) ?? null }) },
}));
const workspace = mkdtempSync(join(tmpdir(), "lax-workspace-"));
vi.mock("../config.js", () => ({
  workspacePath: (...segments: string[]) => join(workspace, ...segments),
}));

const { bindSessionFolder, chatSessionFolder, codeSessionFolder, stampSessionProjectFolder, takeBoundFolder, workspaceRelative } = await import("./project-folder.js");
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

describe("stampSessionProjectFolder", () => {
  it("anchors a code session at its project's folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-code-folder-"));
    projects.set("p1", { workspace: dir });
    expect(stampSessionProjectFolder({ id: "chat-c1", mode: "code", projectId: "p1" })).toBe(dir);
    expect(sessionWorkRootOf("chat-c1")).toBeTruthy();
    clearSessionWorkRoot("chat-c1");
  });

  it("anchors a chat at the workspace folder it was bound to, while it exists", () => {
    mkdirSync(join(workspace, "apps", "calendar"), { recursive: true });
    expect(stampSessionProjectFolder({ id: "chat-b1", folder: "apps/calendar" })).toBe(join(workspace, "apps", "calendar"));
    expect(sessionWorkRootOf("chat-b1")).toBe(join(workspace, "apps", "calendar"));
    clearSessionWorkRoot("chat-b1");
    expect(stampSessionProjectFolder({ id: "chat-b2", folder: "apps/gone" })).toBeUndefined();
    expect(sessionWorkRootOf("chat-b2")).toBeUndefined();
  });

  it("leaves an unbound chat, an App IDE session and a code session without a project folder alone", () => {
    projects.set("p2", { workspace: mkdtempSync(join(tmpdir(), "lax-code-folder-")) });
    projects.set("p3", {});
    expect(stampSessionProjectFolder({ id: "chat-x", projectId: "p2" })).toBeUndefined();
    expect(stampSessionProjectFolder({ id: "ide-todo", mode: "code", projectId: "p2" })).toBeUndefined();
    expect(stampSessionProjectFolder({ id: "chat-y", mode: "code", projectId: "p3" })).toBeUndefined();
    expect(stampSessionProjectFolder({ id: "chat-z", mode: "code" })).toBeUndefined();
    for (const id of ["chat-x", "ide-todo", "chat-y", "chat-z"]) expect(sessionWorkRootOf(id)).toBeUndefined();
  });
});

// A chat that starts building without a folder gets one: the app's folder in
// the workspace, bound by the tool that created it and kept by the turn's end.
describe("bindSessionFolder", () => {
  it("binds an unbound chat to an app folder inside the workspace, once, and hands the turn the folder to keep", () => {
    const dir = join(workspace, "apps", "todo");
    mkdirSync(dir, { recursive: true });
    expect(bindSessionFolder("chat-n1", dir)).toBe("apps/todo");
    expect(sessionWorkRootOf("chat-n1")).toBe(dir);
    expect(bindSessionFolder("chat-n1", join(workspace, "apps", "other"))).toBeNull();
    expect(takeBoundFolder("chat-n1")).toBe("apps/todo");
    expect(takeBoundFolder("chat-n1")).toBeUndefined();
    clearSessionWorkRoot("chat-n1");
  });

  it("never binds a session that already has a folder, nor to a folder outside the workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-code-folder-"));
    projects.set("p4", { workspace: dir });
    stampSessionProjectFolder({ id: "chat-c4", mode: "code", projectId: "p4" });
    expect(bindSessionFolder("chat-c4", join(workspace, "apps", "todo"))).toBeNull();
    expect(sessionWorkRootOf("chat-c4")).toBe(dir);
    clearSessionWorkRoot("chat-c4");
    expect(bindSessionFolder("chat-n2", dir)).toBeNull();
    expect(sessionWorkRootOf("chat-n2")).toBeUndefined();
    expect(bindSessionFolder(undefined, join(workspace, "apps", "todo"))).toBeNull();
  });

  it("chatSessionFolder and workspaceRelative agree on what is inside the workspace", () => {
    expect(workspaceRelative(join(workspace, "apps", "todo"))).toBe("apps/todo");
    expect(workspaceRelative(workspace)).toBeNull();
    expect(workspaceRelative(tmpdir())).toBeNull();
    expect(chatSessionFolder("apps/todo")).toBe(join(workspace, "apps", "todo"));
    expect(chatSessionFolder(tmpdir())).toBeUndefined();
  });
});

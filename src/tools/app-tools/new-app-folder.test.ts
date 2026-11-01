// The write that starts an app binds the chat to its folder and lands the
// structure kit, by hand or by build tool alike. Live 2026-10-31: a game
// written by hand got neither, and a code session bound to an empty folder
// was answered with a workspace path by the design brief.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The apps anchor is the literal `workspace/apps/` segment, as on an install.
const workspace = join(mkdtempSync(join(tmpdir(), "lax-ws-")), "workspace");
vi.mock("../../config.js", () => ({
  workspacePath: (...segments: string[]) => join(workspace, ...segments),
}));

const { appFolderStartedBy, appStartNote, onAppFolderStarted } = await import("./new-app-folder.js");
const { appRootForSession, describeAppRoot } = await import("./app-root.js");
const { appDesignBrief, resetDesignDeliveries } = await import("./design-gate.js");
const { checkAppWrite } = await import("./write-guard.js");
const { setSessionWorkRoot, clearSessionWorkRoot, sessionWorkRootOf } = await import("../../workspace/paths.js");
const { takeBoundFolder } = await import("../../session/project-folder.js");

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const PAGE = `<html><head>${VIEWPORT}<title>Park</title></head><body>${"x".repeat(300)}</body></html>`;
let n = 0;
let sid = "";
beforeEach(() => { resetDesignDeliveries(); sid = `s-${++n}`; });
afterEach(() => clearSessionWorkRoot(sid));

describe("a chat's first app write", () => {
  it("is the start of the app while its folder is empty or missing, and not after", () => {
    const file = join(workspace, "apps", "park", "index.html");
    expect(appFolderStartedBy(file, sid)).toBe(join(workspace, "apps", "park").replace(/\\/g, "/"));
    mkdirSync(join(workspace, "apps", "park"), { recursive: true });
    expect(appFolderStartedBy(file, sid)).toBeTruthy();
    writeFileSync(file, PAGE);
    expect(appFolderStartedBy(file, sid)).toBeNull();
    expect(appFolderStartedBy(join(workspace, "notes.md"), sid)).toBeNull();
  });

  it("binds the chat to the app's folder and lands the kit around the file, with the page's root as the source root", () => {
    const root = join(workspace, "apps", "game");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.html"), PAGE);
    const start = onAppFolderStarted(root.replace(/\\/g, "/"), sid);
    expect(start.bound).toBe("apps/game");
    expect(sessionWorkRootOf(sid)?.replace(/\\/g, "/")).toBe(root.replace(/\\/g, "/"));
    expect(takeBoundFolder(sid)).toBe("apps/game");
    expect(start.kit.written).toEqual(expect.arrayContaining(["AGENTS.md", "ARCHITECTURE.md", "scripts/check-structure.mjs"]));
    expect(readFileSync(join(root, "index.html"), "utf-8")).toBe(PAGE);
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toContain("`./`");
    const note = appStartNote(start);
    expect(note).toContain("This chat now works in workspace/apps/game/");
    expect(note).toContain("node scripts/check-structure.mjs");
  });

  it("does not rebind a session that has a folder, and never overwrites what is there", () => {
    const root = join(workspace, "apps", "second");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "mine");
    setSessionWorkRoot(sid, join(workspace, "apps", "first"));
    const start = onAppFolderStarted(root.replace(/\\/g, "/"), sid);
    expect(start.bound).toBeNull();
    expect(start.kit.skipped).toContain("AGENTS.md");
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe("mine");
    expect(appStartNote(start)).toMatch(/^Started workspace\/apps\/second\//);
  });
});

describe("a code session's bound folder is the app", () => {
  it("the design brief answers with the bound folder, and the first UI write there is held for the system only while the project is new", async () => {
    const bound = mkdtempSync(join(tmpdir(), "lax-code-"));
    setSessionWorkRoot(sid, bound);
    expect(appRootForSession(undefined, sid)).toBe(bound.replace(/\\/g, "/"));
    expect(appRootForSession("ignored", sid)).toBe(bound.replace(/\\/g, "/"));
    const res = await (appDesignBrief.execute({ description: "a park game", _sessionId: `other-${sid}` }) as Promise<{ content: string; isError?: boolean }>);
    expect(res.isError).toBeTruthy();
    const held = checkAppWrite(join(bound, "index.html"), PAGE, sid);
    expect(held.allow).toBe(false);
    expect(held.message).toContain(`DESIGN SYSTEM`);
    expect(checkAppWrite(join(bound, "index.html"), PAGE, sid).allow).toBe(true);
    expect(checkAppWrite(join(bound, "index.html"), `${PAGE}<script src="https://cdn.jsdelivr.net/x.js"></script>`, sid).allow).toBe(true);
    expect(describeAppRoot(bound)).toBe(bound.replace(/\\/g, "/"));
  });

  it("an existing project in the bound folder is not held: its first UI edit is not a first draft", () => {
    const bound = mkdtempSync(join(tmpdir(), "lax-code-"));
    writeFileSync(join(bound, "package.json"), "{}");
    setSessionWorkRoot(sid, bound);
    expect(checkAppWrite(join(bound, "src", "App.tsx"), "export const App = () => null;", sid).allow).toBe(true);
  });

  it("the brief for the bound folder names it, and a kit landing there keeps the project kind's roots", async () => {
    const bound = mkdtempSync(join(tmpdir(), "lax-code-"));
    setSessionWorkRoot(sid, bound);
    const res = await (appDesignBrief.execute({ description: "a park game", _sessionId: sid }) as Promise<{ content: string }>);
    expect(res.content).toContain(`DESIGN SYSTEM for ${bound.replace(/\\/g, "/")}/`);
    writeFileSync(join(bound, "package.json"), JSON.stringify({ name: "park", devDependencies: { vitest: "1" } }));
    const start = onAppFolderStarted(bound.replace(/\\/g, "/"), sid);
    expect(start.bound).toBeNull();
    expect(existsSync(join(bound, "src", "module-seals.test.ts"))).toBe(true);
    expect(readFileSync(join(bound, "AGENTS.md"), "utf-8")).not.toContain("`./`");
  });
});

describe("a chat names its app", () => {
  it("the brief for a chat with no folder needs the app's name and answers with its workspace path", async () => {
    const none = await (appDesignBrief.execute({ description: "x", _sessionId: sid }) as Promise<{ isError?: boolean }>);
    expect(none.isError).toBe(true);
    const res = await (appDesignBrief.execute({ app: "todo", description: "a todo list", _sessionId: sid }) as Promise<{ content: string }>);
    expect(res.content).toContain("DESIGN SYSTEM for workspace/apps/todo/");
  });
});

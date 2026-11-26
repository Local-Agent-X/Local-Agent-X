// Where a chat's terminal opens: the folder on the chat's record, asked for by
// the Terminal tab when it starts that chat's shell.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../server-context.js";

const workspace = mkdtempSync(join(tmpdir(), "lax-workspace-"));
vi.mock("../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.js")>()),
  workspacePath: (...segments: string[]) => join(workspace, ...segments),
}));

const { handleSessionFolderRoute } = await import("./session-folder.js");

async function ask(query: string, sessions: Record<string, { folder?: string }>): Promise<{ status: number; body: Record<string, unknown> } | null> {
  let status = 0;
  let body = "";
  const res = { writeHead(code: number) { status = code; return res; }, setHeader() {}, end(b: string) { body = b; } } as unknown as ServerResponse;
  const ctx = { sessionStore: { load: (id: string) => (sessions[id] ? { id, ...sessions[id] } : null) } } as unknown as ServerContext;
  const handled = await handleSessionFolderRoute("GET", new URL(`http://127.0.0.1${query}`), { headers: {} } as IncomingMessage, res, ctx, "operator" as never);
  return handled ? { status, body: JSON.parse(body) as Record<string, unknown> } : null;
}

describe("GET /api/session-folder", () => {
  it("is the folder the chat was bound to, while it exists", async () => {
    mkdirSync(join(workspace, "apps", "label-check"), { recursive: true });
    const sessions = { "chat-a": { folder: "apps/label-check" }, "chat-b": { folder: "apps/gone" }, "chat-c": {} };
    expect((await ask("/api/session-folder?session=chat-a", sessions))?.body).toEqual({ folder: join(workspace, "apps", "label-check") });
    expect((await ask("/api/session-folder?session=chat-b", sessions))?.body).toEqual({ folder: null });
    expect((await ask("/api/session-folder?session=chat-c", sessions))?.body).toEqual({ folder: null });
  });

  it("is null for a chat with no record, and refuses an id that is not one", async () => {
    expect((await ask("/api/session-folder?session=chat-unknown", {}))?.body).toEqual({ folder: null });
    expect((await ask("/api/session-folder?session=..%2F..%2Fetc", {}))?.status).toBe(400);
    expect((await ask("/api/session-folder", {}))?.status).toBe(400);
  });

  // A build wrote its spec and plan and the owner could not read them (2026-11-25).
  it("lists the project's markdown at its root, spec/ and twins/, and reads one of them", async () => {
    const dir = join(workspace, "apps", "docs-app");
    mkdirSync(join(dir, "spec"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# Docs app");
    writeFileSync(join(dir, "spec", "plan.md"), "## Chunk 1");
    writeFileSync(join(dir, "src", "notes.md"), "not a project document");
    const sessions = { "chat-d": { folder: "apps/docs-app" } };
    const listed = await ask("/api/session-folder/docs?session=chat-d", sessions);
    expect((listed?.body.docs as Array<{ path: string }>).map((d) => d.path).sort()).toEqual(["README.md", "spec/plan.md"]);
    expect((await ask("/api/session-folder/doc?session=chat-d&path=spec%2Fplan.md", sessions))?.body).toEqual({ path: "spec/plan.md", text: "## Chunk 1" });
  });

  it("reads only markdown inside the chat's own project", async () => {
    const sessions = { "chat-d": { folder: "apps/docs-app" } };
    expect((await ask("/api/session-folder/doc?session=chat-d&path=..%2F..%2Fsecret.md", sessions))?.status).toBe(404);
    expect((await ask("/api/session-folder/doc?session=chat-d&path=package.json", sessions))?.status).toBe(404);
    expect((await ask("/api/session-folder/docs?session=chat-none", {}))?.body).toEqual({ folder: null, docs: [] });
  });

  it("leaves every other path to the next handler", async () => {
    expect(await ask("/api/sessions/chat-a", {})).toBeNull();
  });
});

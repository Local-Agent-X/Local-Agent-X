/**
 * POST /api/projects with codeFolder: the sidebar's Code side adding a folder.
 * The folder must exist; adding one twice returns the first; a name another
 * project already holds gets the parent folder's name beside it.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerContext } from "../src/server-context.js";
import type { Project } from "../src/agent-store/index.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

vi.mock("../src/chat-ws/index.js", () => ({ broadcastAll: vi.fn() }));
const { handleProjectRoutes } = await import("../src/routes/agents/projects.js");

const root = mkdtempSync(join(tmpdir(), "lax-code-folder-"));
const repo = join(root, "work", "app");
const other = join(root, "client", "app");
mkdirSync(repo, { recursive: true });
mkdirSync(other, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function store(initial: Project[] = []) {
  const projects = [...initial];
  return {
    projects,
    projectStore: {
      list: () => projects,
      findByName: (n: string) => projects.find((p) => p.name.toLowerCase() === n.toLowerCase()) ?? null,
      create: (p: Omit<Project, "id" | "createdAt" | "updatedAt">) => {
        const full = { ...p, id: `proj-${projects.length + 1}`, createdAt: 1, updatedAt: 1 } as Project;
        projects.push(full);
        return full;
      },
    },
  };
}

async function post(ctx: ReturnType<typeof store>, body: unknown) {
  const cap = mockResponse();
  await handleProjectRoutes("POST", new URL("http://test/api/projects"), mockJsonRequest(body), cap.res, ctx as unknown as ServerContext, "user");
  return { status: cap.status, body: JSON.parse(cap.body) };
}

describe("POST /api/projects — a code folder", () => {
  it("is named after the folder and marked as a code folder", async () => {
    const ctx = store();
    const r = await post(ctx, { codeFolder: true, workspace: repo });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "app", workspace: repo, codeFolder: true });
  });

  it("adding the same folder again returns the first, not a second", async () => {
    const ctx = store();
    const first = await post(ctx, { codeFolder: true, workspace: repo });
    const again = await post(ctx, { codeFolder: true, workspace: join(repo, ".") });
    expect(again.body.id).toBe(first.body.id);
    expect(ctx.projects).toHaveLength(1);
  });

  it("two checkouts with the same name are both added, the second named with its parent", async () => {
    const ctx = store();
    await post(ctx, { codeFolder: true, workspace: repo });
    const second = await post(ctx, { codeFolder: true, workspace: other });
    expect(second.body.name).toBe("app (client)");
  });

  it("a path that is not a folder on this computer is refused", async () => {
    const ctx = store();
    const r = await post(ctx, { codeFolder: true, workspace: join(root, "missing") });
    expect(r.status).toBe(400);
    expect(ctx.projects).toHaveLength(0);
  });
});

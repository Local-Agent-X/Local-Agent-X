import { describe, it, expect, vi, beforeEach } from "vitest";

// registerDevServer (whose clean kill-then-restart is covered in
// src/tools/dev-server.test.ts) is modelled here, and so is the shell cage
// wait, so no test spawns a process or reaches the Windows cage's helper.
const seam = vi.hoisted(() => ({
  events: [] as string[],
  cage: { ready: true } as { ready: true } | { ready: false; reason: string },
}));
vi.mock("../src/tools/dev-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/dev-server.js")>();
  return {
    ...actual,
    readDevServerRecord: (appId: string) => appId === "notes"
      ? { appId, command: "node server.js", port: 5180, cwd: "/tmp/notes", connector: "dev-notes", sessionId: "s0", kind: "backend" as const }
      : actual.readDevServerRecord(appId),
    registerDevServer: (input: { appId: string; command: string; port: number }) => {
      seam.events.push(`register:${input.appId}:${input.command}:${input.port}`);
      return { ok: true as const, connector: `dev-${input.appId}`, sessionId: "s1", port: input.port, cwd: "/tmp/notes", restarted: true, kind: "backend" as const };
    },
  };
});
vi.mock("../src/tools/dev-server-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/dev-server-tools.js")>()),
  awaitDevServerCage: async () => { seam.events.push("cage"); return seam.cage; },
}));

import { handleAppRoutes } from "../src/routes/apps.js";
import type { ServerContext } from "../src/server-context.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

function makeCtx(): ServerContext {
  return {
    appRegistry: { get: () => undefined, list: () => [] },
    config: { workspace: "/tmp/lax-restart-test-ws", port: 7007 },
  } as unknown as ServerContext;
}

async function restart(id: string) {
  const cap = mockResponse();
  const handled = await handleAppRoutes("POST", new URL(`http://test/api/apps/${id}/restart-backend`), mockJsonRequest({}), cap.res, makeCtx(), "user");
  return { handled, status: cap.status, body: cap.body ? JSON.parse(cap.body) as Record<string, unknown> : null };
}

beforeEach(() => {
  seam.events = [];
  seam.cage = { ready: true };
});

describe("POST /api/apps/<id>/restart-backend", () => {
  it("404s with a clear message when the app has no backend dev server", async () => {
    // An id with no ~/.lax/dev-servers record → readDevServerRecord returns null.
    const r = await restart("no-backend-here-xyzzy");
    expect(r.handled).toBe(true);
    expect(r.status).toBe(404);
    expect(String(r.body?.error)).toMatch(/no backend/i);
    expect(seam.events).toEqual([]);
  });

  it("does not match a malformed restart path (leaves it for other handlers)", async () => {
    // The id regex rejects "bad..id" so this branch never claims it.
    expect((await restart("bad..id")).handled).toBe(false);
  });

  // registerDevServer stops the running backend before its synchronous start,
  // which a Windows cage that is not ready refuses.
  it("restarts from the record only once the shell cage is ready", async () => {
    const r = await restart("notes");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, port: 5180, restarted: true });
    expect(seam.events).toEqual(["cage", "register:notes:node server.js:5180"]);
  });

  it("a cage that is not ready leaves the running backend alone and says why", async () => {
    seam.cage = { ready: false, reason: "The Windows shell cage is still being verified; try again in a few seconds. Nothing was stopped or started." };
    const r = await restart("notes");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "The Windows shell cage is still being verified; try again in a few seconds. Nothing was stopped or started." });
    expect(seam.events).toEqual(["cage"]);
  });
});

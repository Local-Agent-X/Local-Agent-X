import { describe, it, expect } from "vitest";
import { handleAppRoutes } from "../src/routes/apps.js";
import type { ServerContext } from "../src/server-context.js";
import { mockJsonRequest, mockResponse } from "./helpers/http-mocks.js";

// The restart-backend route is thin glue over registerDevServer (whose clean
// kill-then-restart is covered in src/tools/dev-server.test.ts). The branch
// worth pinning here is the GUARD: an app with no registered backend must get a
// clear 404, not a 500 or a spurious spawn. (The success branch spawns a real
// process, so it's exercised by the dev-server unit tests, not here.)
function makeCtx(): ServerContext {
  return {
    appRegistry: { get: () => undefined, list: () => [] },
    config: { workspace: "/tmp/lax-restart-test-ws", port: 7007 },
  } as unknown as ServerContext;
}

describe("POST /api/apps/<id>/restart-backend", () => {
  it("404s with a clear message when the app has no backend dev server", async () => {
    const ctx = makeCtx();
    // An id with no ~/.lax/dev-servers record → readDevServerRecord returns null.
    const url = new URL("http://test/api/apps/no-backend-here-xyzzy/restart-backend");
    const req = mockJsonRequest({});
    const cap = mockResponse();

    const handled = await handleAppRoutes("POST", url, req, cap.res, ctx, "user");

    expect(handled).toBe(true);
    expect(cap.status).toBe(404);
    expect(JSON.parse(cap.body).error).toMatch(/no backend/i);
  });

  it("does not match a malformed restart path (leaves it for other handlers)", async () => {
    const ctx = makeCtx();
    const url = new URL("http://test/api/apps/bad..id/restart-backend");
    const req = mockJsonRequest({});
    const cap = mockResponse();

    const handled = await handleAppRoutes("POST", url, req, cap.res, ctx, "user");
    // The id regex rejects "bad..id" so this branch never claims it.
    expect(handled).toBe(false);
  });
});

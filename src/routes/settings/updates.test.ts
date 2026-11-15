// The update routes are reached through the settings dispatcher. Moving them
// into their own handler once left it imported but never listed, and every
// /api/updates/* request answered 404 (found by the boot check, 2026-11-15).
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../update-progress.js", () => ({ updateProgress: () => ({ mode: "idle", step: null, label: "", percent: 0 }) }));
vi.mock("../../update-staging.js", () => ({ readyUpdate: () => null }));

const { handleSettingsRoutes } = await import("./index.js");

function fakeRes(): { res: ServerResponse; body: () => string; status: () => number } {
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => { status = s; return res; },
    setHeader: () => res,
    getHeader: () => undefined,
    end: (b?: string) => { body = b ?? ""; return res; },
    headersSent: false,
  } as unknown as ServerResponse;
  return { res, body: () => body, status: () => status };
}

describe("update routes", () => {
  it("answer through the settings dispatcher", async () => {
    const { res, body, status } = fakeRes();
    const req = { headers: {} } as IncomingMessage;
    const handled = await handleSettingsRoutes("GET", new URL("http://x/api/updates/progress"), req, res, {} as never, "operator" as never);
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toMatchObject({ mode: "idle", percent: 0 });
  });
});

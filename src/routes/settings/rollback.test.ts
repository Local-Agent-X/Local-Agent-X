import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { captureBeforeCall, recordCapture } from "../../autonomy/rollback.js";
import { handleRollbackRoutes } from "./rollback.js";
import type { ServerContext } from "../../server-context.js";

function call(method: string, path: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as { headers: Record<string, string> }).headers = {};
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  const handled = handleRollbackRoutes(method, new URL(`http://x${path}`), req, res as unknown as ServerResponse, {} as ServerContext, "operator" as never);
  return handled.then((h) => ({ handled: h, status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }));
}

describe("POST /api/rollback/rewind", () => {
  it("needs the session and the request", async () => {
    expect((await call("POST", "/api/rollback/rewind", { opId: "op" })).status).toBe(400);
  });

  it("previews, then rewinds, a request's file changes", async () => {
    const dir = mkdtempSync(join(homedir(), "lax-rewind-route-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "before");
    const sessionId = `s-${Date.now()}`, opId = `op-${Date.now()}`;
    const pending = captureBeforeCall({ toolCallId: `tc-${Date.now()}`, tool: "write", sessionId, opId }, [file]);
    writeFileSync(file, "after");
    recordCapture(pending);

    const plan = await call("POST", "/api/rollback/rewind", { sessionId, opId, preview: true });
    expect(plan).toMatchObject({ status: 200, json: { files: [file], laterRequests: 0 } });
    expect(readFileSync(file, "utf-8")).toBe("after");

    const done = await call("POST", "/api/rollback/rewind", { sessionId, opId });
    expect(done).toMatchObject({ status: 200, json: { ok: true, restored: [file] } });
    expect(readFileSync(file, "utf-8")).toBe("before");
    expect((await call("POST", "/api/rollback/rewind", { sessionId, opId })).status).toBe(404);
  });

  it("leaves other paths to the next handler", async () => {
    expect((await call("GET", "/api/system-status")).handled).toBe(false);
  });
});

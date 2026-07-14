/**
 * Client freeze-report intake (POST /api/health/client-freeze).
 *
 * The renderer's freeze probe ships UI-stall events here so they land in
 * server.log (console is mirrored there) next to server restart/OTA lines —
 * the in-memory ring buffer in the window is lost on reload, which is how
 * intermittent whole-app freezes stayed unattributed. Covers:
 *   - 200 + [client-freeze] console.warn line for a valid entry
 *   - sub-200ms noise entries are dropped
 *   - malformed bodies still answer 200 without logging
 *   - unrelated method/path fall through (return false)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHealthRoutes } from "./health.js";

function mkReq(body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  return Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
}

function mkRes() {
  let status = 0;
  let payload = "";
  const res = {
    writeHead: (s: number) => { status = s; return res; },
    setHeader: () => res,
    end: (data?: string) => { payload = data ?? ""; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => payload };
}

const url = (path: string) => new URL(`http://127.0.0.1:7007${path}`);

afterEach(() => vi.restoreAllMocks());

describe("POST /api/health/client-freeze", () => {
  it("logs a [client-freeze] line and answers ok for a valid entry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res, status, body } = mkRes();
    const handled = await handleHealthRoutes(
      "POST", url("/api/health/client-freeze"),
      mkReq({ entries: [{ kind: "freeze", ms: 14980, t: "10:15:01.123" }] }),
      res, {} as never, "operator" as never,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(JSON.parse(body())).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[client-freeze] freeze 14980ms"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("at:10:15:01.123"));
  });

  it("drops sub-200ms noise but still answers ok", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res, status } = mkRes();
    await handleHealthRoutes(
      "POST", url("/api/health/client-freeze"),
      mkReq({ entries: [{ kind: "freeze", ms: 50 }] }),
      res, {} as never, "operator" as never,
    );
    expect(status()).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("tolerates a malformed body without logging", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { res, status } = mkRes();
    const handled = await handleHealthRoutes(
      "POST", url("/api/health/client-freeze"),
      mkReq("not-an-object"), res, {} as never, "operator" as never,
    );
    expect(handled).toBe(true);
    expect(status()).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls through for other methods and paths", async () => {
    const { res } = mkRes();
    expect(await handleHealthRoutes("POST", url("/api/health"), mkReq({}), res, {} as never, "operator" as never)).toBe(false);
    expect(await handleHealthRoutes("DELETE", url("/api/health/client-freeze"), mkReq(), res, {} as never, "operator" as never)).toBe(false);
  });
});

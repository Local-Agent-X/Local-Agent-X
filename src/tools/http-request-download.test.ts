// http_request's save_to is the download path: the body lands in the file,
// whole or not at all, an error response is shown instead of saved, and the
// path is one the file-access gate vets as a write before the call runs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const served = vi.hoisted(() => ({ status: 200, body: new Uint8Array([0x1f, 0x8b, 0, 1, 2, 3]) }));
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: async () => new actual.Response(served.body, {
      status: served.status,
      headers: { "content-type": served.status === 200 ? "application/gzip" : "text/plain" },
    }),
  };
});

const { createHttpRequestTool } = await import("./http-request.js");
const { saveResponseBody } = await import("./http-download.js");
const { Response } = await import("undici");
const { TOOL_PATH_ARGS } = await import("../tool-registry.js");
const { CREATE_CLASS } = await import("../tool-execution/create-target-path.js");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-download-")); served.status = 200; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("http_request save_to", () => {
  it("writes the body to the file, binary intact, and reports where and how much", async () => {
    const target = join(dir, "pkg", "povray.tar.Z");
    const r = await createHttpRequestTool().execute({ url: "https://example.com/povray.tar.Z", save_to: target });
    expect(r.isError).toBeFalsy();
    expect([...readFileSync(target)]).toEqual([...served.body]);
    expect(r.content).toContain(`Saved 6 bytes (application/gzip) to ${target}`);
  });

  it("returns an error response as usual and saves nothing", async () => {
    served.status = 404;
    const target = join(dir, "missing.tgz");
    const r = await createHttpRequestTool().execute({ url: "https://example.com/missing.tgz", save_to: target });
    expect(r.isError).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("is a write the file-access gate checks, like any file the agent creates", () => {
    expect(TOOL_PATH_ARGS.http_request).toEqual([{ arg: "save_to", action: "write" }]);
    expect(CREATE_CLASS.has("http_request")).toBe(true);
  });
});

describe("saveResponseBody", () => {
  it("stops a download past the limit and keeps nothing, not even the partial file", async () => {
    const target = join(dir, "big.bin");
    await expect(saveResponseBody(new Response(new Uint8Array(64)), target, undefined, 16)).rejects.toThrow(/passed 16 bytes/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

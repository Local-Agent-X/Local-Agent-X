/**
 * GHSA-9mv6 gap 4: the Artifacts panel opened /images, /videos and /uploads
 * with `?token=<operator token>`, and a browser keeps that URL in its history.
 * A window now opens a link signed for that one file; the route serves it, and
 * the signature opens nothing else.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { serveProtectedAssets } from "./static-assets.js";
import { signServedMediaPath } from "./agent-file-links.js";
import type { LAXConfig } from "../types.js";

const TOKEN = "operator-token-for-test-0123456789abcdef";
const workspace = mkdtempSync(join(tmpdir(), "lax-media-link-"));
mkdirSync(join(workspace, "images"));
writeFileSync(join(workspace, "images", "cat.png"), "png-bytes");
writeFileSync(join(workspace, "images", "dog.png"), "other-bytes");
const config = { authToken: TOKEN, workspace } as LAXConfig;

function get(path: string, headers: Record<string, string> = {}): { status: number; body: string } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    setHeader() {},
    end(body?: unknown) { out.body = body === undefined ? "" : String(body); },
  } as unknown as ServerResponse;
  const req = { headers } as IncomingMessage;
  serveProtectedAssets("GET", new URL(path, "http://127.0.0.1:7007"), req, res, config, workspace);
  return out;
}

describe("served media opened in a window", () => {
  it("serves a file to the link signed for it", () => {
    const sig = signServedMediaPath(TOKEN, "/images/cat.png");
    expect(get(`/images/cat.png?sig=${sig}`)).toEqual({ status: 200, body: "png-bytes" });
  });

  it("a signature opens only its own file", () => {
    const sig = signServedMediaPath(TOKEN, "/images/cat.png");
    expect(get(`/images/dog.png?sig=${sig}`).status).toBe(401);
  });

  it("refuses a request with neither the token nor a signature", () => {
    expect(get("/images/cat.png").status).toBe(401);
  });

  it("still serves the UI's own requests, which send the token in the header", () => {
    expect(get("/images/cat.png", { authorization: `Bearer ${TOKEN}` }).status).toBe(200);
  });
});

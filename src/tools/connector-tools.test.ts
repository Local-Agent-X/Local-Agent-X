import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorCreateTool } from "./connector-tools.js";
import { parseManifest } from "../routes/connector-proxy.js";

let dir: string;
const prev = process.env.LAX_DATA_DIR;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-connectors-test-"));
  process.env.LAX_DATA_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

function run(args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
  return connectorCreateTool.execute!(args) as Promise<{ content: string; isError?: boolean }>;
}

describe("connector_create", () => {
  it("writes a keyless connector the proxy can load back", async () => {
    const r = await run({ name: "coingecko", upstream: "https://api.coingecko.com", auth: { type: "none" }, allow: ["GET /api/v3/simple/price"] });
    expect(r.isError).toBeFalsy();
    const file = join(dir, "connectors", "coingecko.json");
    expect(existsSync(file)).toBe(true);
    expect(parseManifest(readFileSync(file, "utf-8")).ok).toBe(true);
    expect(r.content).toContain("/api/connectors/coingecko/<path>");
  });

  it("defaults auth to none when omitted", async () => {
    const r = await run({ name: "publicapi", upstream: "https://api.example.com", allow: ["GET /v1/data"] });
    expect(r.isError).toBeFalsy();
  });

  it("rejects an invalid manifest (non-https upstream) via parseManifest", async () => {
    const r = await run({ name: "bad", upstream: "ftp://nope", allow: ["GET /x"] });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/upstream/);
  });

  it("rejects a non-slug name and writes nothing", async () => {
    const r = await run({ name: "Bad Name", upstream: "https://api.example.com", allow: ["GET /x"] });
    expect(r.isError).toBe(true);
    expect(existsSync(join(dir, "connectors", "Bad Name.json"))).toBe(false);
  });

  it("warns when a bearer connector references an unstored secret", async () => {
    const r = await run({ name: "needskey", upstream: "https://api.example.com", auth: { type: "bearer", secret: "EXAMPLE_TOKEN_DEFINITELY_UNSET" }, allow: ["GET /me"] });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/not stored yet/);
  });
});

import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import { handleSecretsRoutes } from "./secrets.js";

function makeReq(body?: unknown): Readable & { headers: Record<string, string> } {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: "",
    headers: new Map<string, string>(),
    setHeader(name: string, value: string) { res.headers.set(name, value); },
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  return res;
}

async function request(method: "POST" | "DELETE", path: string, body?: unknown) {
  const values = new Set<string>();
  const secretsStore = {
    set: vi.fn((name: string) => values.add(name)),
    delete: vi.fn((name: string) => values.delete(name)),
  };
  const broadcastAll = vi.fn();
  if (method === "DELETE") values.add("PLUGIN_TOKEN");
  const req = makeReq(body);
  const res = makeRes();
  await handleSecretsRoutes(
    method,
    new URL(`http://127.0.0.1${path}`),
    req as unknown as Parameters<typeof handleSecretsRoutes>[2],
    res as unknown as Parameters<typeof handleSecretsRoutes>[3],
    { secretsStore, broadcastAll } as unknown as Parameters<typeof handleSecretsRoutes>[4],
    "operator",
  );
  return { res, secretsStore, broadcastAll };
}

describe("secret mutation plugin lifecycle notifications", () => {
  it("stores the value and broadcasts flags without the value", async () => {
    const result = await request("POST", "/api/secrets", { name: "PLUGIN_TOKEN", value: "super-secret-value" });

    expect(result.res.statusCode).toBe(200);
    expect(JSON.parse(result.res.body)).toEqual({ ok: true, name: "PLUGIN_TOKEN" });
    expect(result.res.body).not.toContain("super-secret-value");
    expect(result.broadcastAll).toHaveBeenCalledWith({
      type: "settings_changed",
      settings: { secrets: true, plugins: true },
    });
  });

  it("confirms vault deletion and broadcasts only state flags", async () => {
    const result = await request("DELETE", "/api/secrets/PLUGIN_TOKEN");

    expect(result.res.statusCode).toBe(200);
    expect(result.secretsStore.delete).toHaveBeenCalledWith("PLUGIN_TOKEN");
    expect(result.broadcastAll).toHaveBeenCalledWith({
      type: "settings_changed",
      settings: { secrets: true, plugins: true },
    });
  });
});

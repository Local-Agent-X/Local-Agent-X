import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const routeMocks = vi.hoisted(() => ({
  pluginManager: {
    listPlugins: vi.fn(),
    getPluginStatus: vi.fn(),
    loadPlugin: vi.fn(),
    disablePlugin: vi.fn(),
    enablePlugin: vi.fn(),
    retryPlugin: vi.fn(),
  },
}));

vi.mock("../../plugin-system.js", () => ({ pluginManager: routeMocks.pluginManager }));

import { handlePluginsRoutes } from "./plugins.js";

function makeReq(body?: unknown): Readable & { headers: Record<string, string> } {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(chunks) as Readable & { headers: Record<string, string> };
  req.headers = {};
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  return res;
}

async function request(method: "GET" | "POST", path: string, body?: unknown, role: "operator" | "agent" = "operator") {
  const req = makeReq(body);
  const res = makeRes();
  const broadcastAll = vi.fn();
  const handled = await handlePluginsRoutes(
    method,
    new URL(`http://127.0.0.1${path}`),
    req as unknown as Parameters<typeof handlePluginsRoutes>[2],
    res as unknown as Parameters<typeof handlePluginsRoutes>[3],
    { broadcastAll } as unknown as Parameters<typeof handlePluginsRoutes>[4],
    role,
  );
  return { handled, status: res.statusCode, body: JSON.parse(res.body) as unknown, broadcastAll };
}

beforeEach(() => {
  routeMocks.pluginManager.listPlugins.mockReset();
  routeMocks.pluginManager.getPluginStatus.mockReset();
  routeMocks.pluginManager.loadPlugin.mockReset();
  routeMocks.pluginManager.disablePlugin.mockReset();
  routeMocks.pluginManager.enablePlugin.mockReset();
  routeMocks.pluginManager.retryPlugin.mockReset();
  routeMocks.pluginManager.listPlugins.mockReturnValue([]);
  routeMocks.pluginManager.getPluginStatus.mockReturnValue({ id: "sample", registryId: "sample", status: "loaded" });
  routeMocks.pluginManager.loadPlugin.mockResolvedValue({ id: "sample" });
  routeMocks.pluginManager.disablePlugin.mockReturnValue(true);
  routeMocks.pluginManager.enablePlugin.mockResolvedValue({ id: "sample" });
  routeMocks.pluginManager.retryPlugin.mockResolvedValue({ id: "sample" });
});

describe("plugin lifecycle routes", () => {
  it("allows non-operators to list but denies every lifecycle mutation before side effects", async () => {
    expect(await request("GET", "/api/plugins", undefined, "agent")).toMatchObject({ status: 200, body: [] });
    for (const [path, body] of [
      ["/api/plugins/load", { path: "/plugins/sample" }],
      ["/api/plugins/unload", { id: "sample" }],
      ["/api/plugins/enable", { id: "sample" }],
      ["/api/plugins/retry", { id: "sample" }],
    ] as const) {
      const result = await request("POST", path, body, "agent");
      expect(result).toMatchObject({ handled: true, status: 403, body: { error: "Operator access required" } });
      expect(result.broadcastAll).not.toHaveBeenCalled();
    }
    expect(routeMocks.pluginManager.loadPlugin).not.toHaveBeenCalled();
    expect(routeMocks.pluginManager.disablePlugin).not.toHaveBeenCalled();
    expect(routeMocks.pluginManager.enablePlugin).not.toHaveBeenCalled();
    expect(routeMocks.pluginManager.retryPlugin).not.toHaveBeenCalled();
    expect(routeMocks.pluginManager.getPluginStatus).not.toHaveBeenCalled();
  });

  it("uses the process-wide manager for list and load", async () => {
    const list = await request("GET", "/api/plugins");
    const load = await request("POST", "/api/plugins/load", { path: "/plugins/sample" });

    expect(list).toMatchObject({ handled: true, status: 200, body: [] });
    expect(load).toMatchObject({ handled: true, status: 200, body: { ok: true, plugin: { id: "sample", status: "loaded" } } });
    expect(routeMocks.pluginManager.listPlugins).toHaveBeenCalledOnce();
    expect(routeMocks.pluginManager.loadPlugin).toHaveBeenCalledWith("/plugins/sample");
    expect(routeMocks.pluginManager.getPluginStatus).toHaveBeenCalledWith("sample");
    expect(load.broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { plugins: true } });
  });

  it("disables through the same manager and broadcasts the mutation", async () => {
    const result = await request("POST", "/api/plugins/unload", { id: "sample" });

    expect(result).toMatchObject({ handled: true, status: 200, body: { ok: true } });
    expect(routeMocks.pluginManager.disablePlugin).toHaveBeenCalledWith("sample");
    expect(result.broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { plugins: true } });
  });

  it("retries a repairable plugin by ID without accepting a filesystem path", async () => {
    const result = await request("POST", "/api/plugins/retry", { id: "sample" });

    expect(result).toMatchObject({ handled: true, status: 200, body: { ok: true, plugin: { id: "sample" } } });
    expect(routeMocks.pluginManager.retryPlugin).toHaveBeenCalledWith("sample");
    expect(result.broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { plugins: true } });
  });

  it("returns a fixed retry error without leaking paths or secret-shaped details", async () => {
    routeMocks.pluginManager.retryPlugin.mockRejectedValue(
      new Error("C:\\Users\\peter\\private-plugin\\index.mjs SECRET_CANARY_7fd3"),
    );

    const result = await request("POST", "/api/plugins/retry", { id: "sample" });
    const serialized = JSON.stringify(result.body);

    expect(result).toMatchObject({
      handled: true,
      status: 400,
      body: { error: "Plugin retry could not be completed" },
    });
    expect(serialized).not.toContain("private-plugin");
    expect(serialized).not.toContain("SECRET_CANARY_7fd3");
    expect(result.broadcastAll).not.toHaveBeenCalled();
  });

  it("enables through the canonical manager and broadcasts only success", async () => {
    const result = await request("POST", "/api/plugins/enable", { id: "sample" });

    expect(result).toMatchObject({ handled: true, status: 200, body: { ok: true } });
    expect(routeMocks.pluginManager.enablePlugin).toHaveBeenCalledWith("sample");
    expect(result.broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { plugins: true } });
  });

  it("contains enable failures without leaking durable paths or broadcasting", async () => {
    routeMocks.pluginManager.enablePlugin.mockRejectedValue(
      new Error("C:\\private\\plugin SECRET_CANARY_enable"),
    );

    const result = await request("POST", "/api/plugins/enable", { id: "sample" });

    expect(result).toMatchObject({ status: 400, body: { error: "Plugin enable could not be completed" } });
    expect(JSON.stringify(result.body)).not.toContain("private");
    expect(JSON.stringify(result.body)).not.toContain("SECRET_CANARY");
    expect(result.broadcastAll).not.toHaveBeenCalled();
  });

  it("returns a fixed load error without leaking bundle content or paths", async () => {
    routeMocks.pluginManager.loadPlugin.mockRejectedValue(
      new Error("C:\\private\\plugin\\index.mjs SECRET_CANARY_load"),
    );

    const result = await request("POST", "/api/plugins/load", { path: "C:\\private\\plugin" });

    expect(result).toMatchObject({ status: 400, body: { error: "Plugin load could not be completed" } });
    expect(JSON.stringify(result.body)).not.toContain("private");
    expect(JSON.stringify(result.body)).not.toContain("SECRET_CANARY");
    expect(result.broadcastAll).not.toHaveBeenCalled();
  });

  it("does not broadcast failed lifecycle mutations", async () => {
    routeMocks.pluginManager.disablePlugin.mockReturnValue(false);
    const result = await request("POST", "/api/plugins/unload", { id: "missing" });

    expect(result).toMatchObject({ handled: true, status: 400, body: { error: "Plugin \"missing\" is not registered" } });
    expect(result.broadcastAll).not.toHaveBeenCalled();
  });
});

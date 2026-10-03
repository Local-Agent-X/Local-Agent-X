import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_ONLY_SETTINGS, handlePreferencesRoutes } from "./preferences.js";
import { getConfigPath, getRuntimeConfig, loadConfig, setRuntimeConfig } from "../../config.js";
import { platformRoot } from "../../platform-root.js";

vi.mock("../../chat-ws/index.js", () => ({ broadcastAll: vi.fn(() => 0) }));

// What the agent's own self-call (no operator token) may and may not do
// through POST /api/settings, next to what the user's Settings page may do.

type Args = Parameters<typeof handlePreferencesRoutes>;
const OPERATOR = "operator-token-for-this-suite";

async function call(method: string, path: string, opts: { body?: Record<string, unknown>; token?: string; publicDir?: string } = {}) {
  const req = Readable.from(opts.body ? [Buffer.from(JSON.stringify(opts.body))] : []) as Readable & { headers: Record<string, string> };
  req.headers = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  const res = {
    statusCode: 0,
    body: "",
    writeHead(status: number) { res.statusCode = status; return res; },
    end(chunk?: string) { if (chunk) res.body = chunk; return res; },
  };
  const ctx = { config: getRuntimeConfig(), dataDir: process.env.LAX_DATA_DIR, publicDir: opts.publicDir } as unknown as Args[4];
  await handlePreferencesRoutes(method, new URL(`http://127.0.0.1${path}`), req as unknown as Args[2], res as unknown as Args[3], ctx, opts.token ? "operator" : "agent");
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
}

const post = (body: Record<string, unknown>, token?: string) => call("POST", "/api/settings", { body, token });

const onDisk = () => JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Record<string, unknown>;

describe("POST /api/settings from the agent", () => {
  let dataDir = "";
  let savedDataDir: string | undefined;

  beforeAll(() => {
    savedDataDir = process.env.LAX_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "prefs-agent-"));
    process.env.LAX_DATA_DIR = dataDir;
  });
  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = savedDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    const config = loadConfig();
    config.authToken = OPERATOR;
    config.dailyBudgetUsd = 75;
    config.enableShell = true;
    setRuntimeConfig(config);
  });

  it("holds the keys that hand the agent authority", () => {
    expect(OPERATOR_ONLY_SETTINGS.map((s) => s.key).sort()).toEqual(["customBaseUrl", "localRuntimes", "port", "threat", "workspace"]);
  });

  it.each(OPERATOR_ONLY_SETTINGS.map((s) => [s.key, s.where]))("refuses %s and names %s", async (key, where) => {
    const value = key === "port" ? 7999 : key === "workspace" ? join(dataDir, "elsewhere") : "x";
    const before = readFileSync(getConfigPath(), "utf-8");
    const r = await post({ [key]: value });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain(where);
    expect(readFileSync(getConfigPath(), "utf-8")).toBe(before);
    expect(existsSync(join(dataDir, "elsewhere"))).toBe(false);
  });

  it("applies an everyday setting with no card and no refusal", async () => {
    expect((await post({ theme: "light", temperature: 0.3 })).status).toBe(200);
    expect(getRuntimeConfig().temperature).toBe(0.3);
  });

  it("switches a capability off, but cannot switch it back on", async () => {
    expect((await post({ enableShell: false })).status).toBe(200);
    expect(getRuntimeConfig().enableShell).toBe(false);
    const r = await post({ enableShell: true });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toMatch(/enableShell can only be widened by the user/);
    expect(getRuntimeConfig().enableShell).toBe(false);
  });

  it("lowers the daily spending cap, but cannot raise or remove it", async () => {
    expect((await post({ dailyBudgetUsd: 20 })).status).toBe(200);
    expect(getRuntimeConfig().dailyBudgetUsd).toBe(20);
    for (const usd of [500, 0]) {
      expect((await post({ dailyBudgetUsd: usd })).status).toBe(403);
      expect(getRuntimeConfig().dailyBudgetUsd).toBe(20);
    }
  });
});

describe("POST /api/settings workspace from the user's Settings page", () => {
  let dataDir = "";
  let savedDataDir: string | undefined;

  beforeAll(() => {
    savedDataDir = process.env.LAX_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "prefs-ws-"));
    process.env.LAX_DATA_DIR = dataDir;
    const config = loadConfig();
    config.authToken = OPERATOR;
    setRuntimeConfig(config);
  });
  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = savedDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("saves an ordinary folder for the next start", async () => {
    const ws = join(dataDir, "my-workspace");
    const r = await post({ workspace: ws }, OPERATOR);
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(onDisk().workspace).toBe(ws);
  });

  it.each([
    ["the home folder", () => homedir()],
    ["the install folder", () => platformRoot()],
    ["a folder of the engine", () => join(platformRoot(), "src")],
  ])("does not save %s, and says why", async (_label, location) => {
    const before = onDisk().workspace;
    const r = await post({ workspace: location() }, OPERATOR);
    expect(r.status).toBe(200);
    expect(String(r.body.workspaceRefused)).toMatch(/home folder|installed in/);
    expect(onDisk().workspace).toBe(before);
  });
});

// The agent may call this route (rbac.ts), and the install's public/ folder
// holds the app's own UI, so no name, listed or not, may delete a file there.
describe("DELETE /api/custom-pages from the agent", () => {
  let dataDir = "";
  let publicDir = "";
  let savedDataDir: string | undefined;
  const registry = () => JSON.parse(readFileSync(join(dataDir, "custom-pages.json"), "utf-8")) as Array<{ name: string }>;

  beforeAll(() => {
    savedDataDir = process.env.LAX_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "prefs-pages-"));
    process.env.LAX_DATA_DIR = dataDir;
    publicDir = join(dataDir, "public");
    mkdirSync(publicDir);
    for (const page of ["app", "tasks", "old-dashboard"]) writeFileSync(join(publicDir, `${page}.html`), "<html></html>");
    writeFileSync(join(dataDir, "custom-pages.json"), JSON.stringify([{ name: "app" }, { name: "old-dashboard" }]));
  });
  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = savedDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a page that is not on the list, and deletes nothing", async () => {
    const r = await call("DELETE", "/api/custom-pages/tasks", { publicDir });
    expect(r.status).toBe(404);
    expect(existsSync(join(publicDir, "tasks.html"))).toBe(true);
  });

  it("takes a listed page off the list without deleting any file, even one named like the app's UI", async () => {
    for (const page of ["app", "old-dashboard"]) {
      expect(await call("DELETE", `/api/custom-pages/${page}`, { publicDir })).toEqual({ status: 200, body: { ok: true, deleted: page } });
      expect(existsSync(join(publicDir, `${page}.html`))).toBe(true);
    }
    expect(registry()).toEqual([]);
  });
});

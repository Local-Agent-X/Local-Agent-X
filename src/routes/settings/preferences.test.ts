import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handlePreferencesRoutes } from "./preferences.js";
import { loadConfig, setRuntimeConfig, getConfigPath } from "../../config.js";
import type { LAXConfig } from "../../types.js";

// ── SV-5 regression: config hot-reload split-brain ──
//
// The config disk-watcher hot-reloads via setRuntimeConfig(loadConfig()),
// which swaps _runtimeConfig to a NEW object. Request handlers, however,
// captured the boot-time config object as ctx.config. Before the fix the
// settings POST persisted ctx.config, so a hand edit made directly in
// config.json (already live via the watcher) was silently clobbered with
// the stale pre-reload snapshot the next time the user saved any setting.
//
// This drives the real POST /api/settings handler through that exact
// sequence and asserts the hand edit survives.

function makeReq(body: unknown): Readable & { headers: Record<string, string> } {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & { headers: Record<string, string> };
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

describe("POST /api/settings persists the live runtime config, not the stale boot object", () => {
  let suiteLaxDir: string;
  let savedLaxDir: string | undefined;
  let savedRuntime: LAXConfig | undefined;

  beforeAll(() => {
    savedLaxDir = process.env.LAX_DATA_DIR;
    suiteLaxDir = mkdtempSync(join(tmpdir(), "sv5-preferences-test-"));
    process.env.LAX_DATA_DIR = suiteLaxDir;
    try { savedRuntime = loadConfig(); } catch { savedRuntime = undefined; }
  });

  afterAll(() => {
    if (savedRuntime) setRuntimeConfig(savedRuntime);
    if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = savedLaxDir;
    rmSync(suiteLaxDir, { recursive: true, force: true });
  });

  it("keeps a config.json hand edit picked up by the hot-reload watcher", async () => {
    // 1. Boot: ctx.config === _runtimeConfig === the boot object.
    const bootConfig = loadConfig();
    setRuntimeConfig(bootConfig);
    expect(bootConfig.maxIterations).toBe(160); // schema default

    // 2. User hand-edits config.json directly, then the disk-watcher fires:
    //    setRuntimeConfig(loadConfig()) swaps _runtimeConfig to a NEW object.
    const configPath = getConfigPath();
    const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
    onDisk.maxIterations = 299; // the hand edit
    writeFileSync(configPath, JSON.stringify(onDisk, null, 2), "utf-8");
    setRuntimeConfig(loadConfig()); // hot-reload → fresh object, ctx.config now stale

    // ctx.config is still the boot object (maxIterations 160) — the split-brain.
    const ctx = { config: bootConfig, dataDir: suiteLaxDir } as unknown as Parameters<typeof handlePreferencesRoutes>[4];

    // 3. User saves an unrelated runtime setting via the UI.
    const req = makeReq({ maxSubAgents: 7 });
    const res = makeRes();
    const handled = await handlePreferencesRoutes(
      "POST",
      new URL("http://127.0.0.1/api/settings"),
      req as unknown as Parameters<typeof handlePreferencesRoutes>[2],
      res as unknown as Parameters<typeof handlePreferencesRoutes>[3],
      ctx,
      "operator",
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);

    // 4. The POST persists the setting AND preserves the hand edit.
    const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(persisted.maxSubAgents).toBe(7); // the new save landed
    expect(persisted.maxIterations).toBe(299); // hand edit NOT clobbered
  });
});

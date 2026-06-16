// Tests for the user-toggleable bridge-enable flag + the two-address bind wiring
// (CHUNK 1c). The persisted flag uses the canonical settings store
// (src/settings.ts → ~/.lax/settings.json, relocated here via LAX_DATA_DIR), and
// the tailnet bind is a SECOND http.Server sharing the loopback server's request
// + upgrade handlers (a single http.Server can't .listen() twice).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

import {
  isBridgeEnabled,
  loadPersistedBridgeEnabled,
  resetPersistedBridgeEnabledForTest,
  BRIDGE_ENABLED_SETTING,
} from "./config.js";
import { createTailnetServer, maybeBindBridge } from "./index.js";
import { saveSettings, reloadSettings } from "../settings.js";

let tmp: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bridge-enable-"));
  prevDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = tmp; // relocate ~/.lax/settings.json into the tmp dir
  delete process.env.LAX_BRIDGE_ENABLED;
  delete process.env.LAX_BRIDGE_BIND_ADDR;
  reloadSettings();                       // drop any cached settings from a prior test
  resetPersistedBridgeEnabledForTest();   // drop the in-memory bridge-flag snapshot
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevDataDir;
  delete process.env.LAX_BRIDGE_ENABLED;
  delete process.env.LAX_BRIDGE_BIND_ADDR;
  reloadSettings();
  resetPersistedBridgeEnabledForTest();
  rmSync(tmp, { recursive: true, force: true });
});

describe("isBridgeEnabled — env OR persisted precedence, default off", () => {
  it("defaults to OFF when nothing is set", () => {
    expect(isBridgeEnabled()).toBe(false);
  });

  it("is ON when the persisted setting is true (no env var)", () => {
    saveSettings({ [BRIDGE_ENABLED_SETTING]: true });
    resetPersistedBridgeEnabledForTest();
    expect(loadPersistedBridgeEnabled()).toBe(true);
    expect(isBridgeEnabled()).toBe(true);
  });

  it("is OFF when the persisted setting is explicitly false", () => {
    saveSettings({ [BRIDGE_ENABLED_SETTING]: false });
    resetPersistedBridgeEnabledForTest();
    expect(isBridgeEnabled()).toBe(false);
  });

  it("is ON via the env override even when the persisted flag is false (headless/dev)", () => {
    saveSettings({ [BRIDGE_ENABLED_SETTING]: false });
    resetPersistedBridgeEnabledForTest();
    process.env.LAX_BRIDGE_ENABLED = "1";
    expect(isBridgeEnabled()).toBe(true);
  });

  it("accepts LAX_BRIDGE_ENABLED='true' as well as '1'", () => {
    process.env.LAX_BRIDGE_ENABLED = "true";
    expect(isBridgeEnabled()).toBe(true);
  });

  it("lazily reads the settings cache if the startup snapshot wasn't loaded", () => {
    saveSettings({ [BRIDGE_ENABLED_SETTING]: true });
    resetPersistedBridgeEnabledForTest(); // snapshot null → must lazily derive true
    expect(isBridgeEnabled()).toBe(true);
  });
});

describe("createTailnetServer — shares the loopback request + upgrade handlers", () => {
  it("creates a SEPARATE server instance that copies every upgrade listener", () => {
    const reqHandler = (): void => {};
    const loopback = createServer(reqHandler);
    const up1 = (): void => {};
    const up2 = (): void => {};
    loopback.on("upgrade", up1);
    loopback.on("upgrade", up2);

    const tailnet = createTailnetServer(loopback, reqHandler);
    expect(tailnet).not.toBe(loopback); // a SECOND server, not the same one
    // Exact same upgrade-handler functions are attached (shared WS routing/auth).
    expect(tailnet.listeners("upgrade")).toEqual(loopback.listeners("upgrade"));
    expect(tailnet.listeners("upgrade")).toContain(up1);
    expect(tailnet.listeners("upgrade")).toContain(up2);

    loopback.close();
    tailnet.close();
  });
});

describe("maybeBindBridge — only binds a second server when enabled + tailnet addr", () => {
  function makeLoopback(): { server: Server; reqHandler: () => void } {
    const reqHandler = (): void => {};
    const server = createServer(reqHandler);
    return { server, reqHandler };
  }

  it("does NOTHING (no second server) when the bridge is disabled", async () => {
    const { server, reqHandler } = makeLoopback();
    const r = await maybeBindBridge(server, reqHandler, 7007);
    expect(r.bound).toBe(false);
    expect(r.tailnetServer).toBeUndefined();
    expect(r.reason).toBe("disabled");
    server.close();
  });

  it("skips the bind when enabled but no tailnet address is resolvable", async () => {
    saveSettings({ [BRIDGE_ENABLED_SETTING]: true });
    resetPersistedBridgeEnabledForTest();
    // No LAX_BRIDGE_BIND_ADDR + (in CI) no tailnet iface → resolves to null.
    // Guard: if this machine genuinely has a tailnet addr, the bind would
    // succeed — assert the addr-present branch instead.
    const { resolveBridgeBindAddr } = await import("./tailnet.js");
    const addr = resolveBridgeBindAddr(undefined);
    const { server, reqHandler } = makeLoopback();
    const r = await maybeBindBridge(server, reqHandler, 0);
    if (addr === null) {
      expect(r.bound).toBe(false);
      expect(r.reason).toBe("no tailnet address");
      expect(r.tailnetServer).toBeUndefined();
    } else {
      expect(r.bound).toBe(true);
      r.tailnetServer?.close();
    }
    server.close();
  });

  it("binds a second server to an explicit bind-addr override (loopback) and shares handlers", async () => {
    saveSettings({ [BRIDGE_ENABLED_SETTING]: true });
    resetPersistedBridgeEnabledForTest();
    // Force a deterministic, bindable address via the override path so the test
    // doesn't depend on a live tailnet. 127.0.0.1 on an ephemeral port is the
    // safe stand-in for a tailnet addr in CI (the prod guard against public
    // binds lives in resolveBridgeBindAddr/tailnet detection, tested elsewhere).
    process.env.LAX_BRIDGE_BIND_ADDR = "127.0.0.1";
    const reqHandler = (): void => {};
    const loopback = createServer(reqHandler);
    const up = (): void => {};
    loopback.on("upgrade", up);
    // Loopback itself must already be listening so the ephemeral port is free
    // for the second server on its OWN ephemeral port.
    await new Promise<void>((res) => loopback.listen(0, "127.0.0.1", res));

    const r = await maybeBindBridge(loopback, reqHandler, 0);
    expect(r.bound).toBe(true);
    expect(r.addr).toBe("127.0.0.1");
    expect(r.tailnetServer).toBeDefined();
    expect(r.tailnetServer).not.toBe(loopback);
    // The second server got the loopback server's upgrade handler.
    expect(r.tailnetServer?.listeners("upgrade")).toContain(up);

    r.tailnetServer?.close();
    loopback.close();
  });
});

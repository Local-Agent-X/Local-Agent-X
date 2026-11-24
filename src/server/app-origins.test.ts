import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_OPEN_APP_ORIGINS, appIdOfPath, appOriginIfOpen, closeAllAppOrigins, closeAppOrigin, ensureAppOrigin, initAppOrigins } from "./app-origins.js";
import { agentOriginPorts } from "../security/layer/agent-origin-port.js";

// One origin per app is what keeps one app's page from reading another's. The
// registry must open a listener only for a real app, keep an app on its port
// across restarts, and never hand a port one app had to another.

let dir: string;
let portsFile: string;
let existing: Set<string>;

function start(): void {
  initAppOrigins({
    listenerFor: (appId, port) => (_req, res) => { res.end(`${appId}@${port()}`); },
    appExists: (appId) => existing.has(appId),
    portsFile,
  });
}

const portOf = (origin: string | null) => Number(new URL(origin ?? "http://x:0").port);
const book = () => JSON.parse(readFileSync(portsFile, "utf-8")) as { ports: Record<string, number>; retired: number[] };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-origins-"));
  portsFile = join(dir, "app-origin-ports.json");
  existing = new Set(["alpha", "beta"]);
  start();
});

afterEach(async () => {
  await closeAllAppOrigins();
  rmSync(dir, { recursive: true, force: true });
});

describe("appIdOfPath", () => {
  it("reads the app id of an app or dashboard path, and nothing that is not one", () => {
    expect(appIdOfPath("/apps/alpha/")).toBe("alpha");
    expect(appIdOfPath("/apps/alpha")).toBe("alpha");
    expect(appIdOfPath("/dashboards/My_Board-2/x/y.js")).toBe("My_Board-2");
    for (const path of ["/apps/", "/apps", "/apps/a.b/", "/apps/%41/", "/apps/a b/", `/apps/${"x".repeat(65)}/`, "/files/apps/alpha/", "/api/apps/alpha"]) {
      expect(appIdOfPath(path), path).toBeNull();
    }
  });
});

describe("an app's listener", () => {
  it("opens on first ask, answers for that app, and is this server's port to the egress gate", async () => {
    const origin = await ensureAppOrigin("alpha");
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(`${origin}/`)).text()).toBe(`alpha@${portOf(origin)}`);
    expect(agentOriginPorts()).toContain(String(portOf(origin)));
    expect(appOriginIfOpen("alpha")).toBe(origin);
  });

  it("is one per app, however many ask at once", async () => {
    const origins = await Promise.all([ensureAppOrigin("alpha"), ensureAppOrigin("alpha"), ensureAppOrigin("alpha")]);
    expect(new Set(origins).size).toBe(1);
    expect(await ensureAppOrigin("beta")).not.toBe(origins[0]);
  });

  it("is never opened for an app that does not exist or a name that is no app id", async () => {
    for (const id of ["ghost", "", "a.b", "../alpha", "a/b", "x".repeat(65)]) {
      expect(await ensureAppOrigin(id), id).toBeNull();
    }
    expect(agentOriginPorts()).toEqual([]);
  });

  it("leaves the egress gate's set when it closes", async () => {
    const origin = await ensureAppOrigin("alpha");
    await closeAppOrigin("alpha");
    expect(appOriginIfOpen("alpha")).toBeNull();
    expect(agentOriginPorts()).not.toContain(String(portOf(origin)));
  });
});

describe("an app's port", () => {
  it("is the same after a restart", async () => {
    const before = await ensureAppOrigin("alpha");
    await closeAllAppOrigins();
    start();
    expect(await ensureAppOrigin("alpha")).toBe(before);
  });

  it("stays the app id's after the app is gone: no other app is given it", async () => {
    const alpha = portOf(await ensureAppOrigin("alpha"));
    await closeAppOrigin("alpha");
    existing.delete("alpha");
    expect(book().ports.alpha).toBe(alpha);
    existing.add("gamma");
    expect(portOf(await ensureAppOrigin("gamma"))).not.toBe(alpha);
  });

  it("is retired, not reused, when it cannot be bound again", async () => {
    const first = portOf(await ensureAppOrigin("alpha"));
    await closeAllAppOrigins();
    const squatter: Server = createServer();
    await new Promise<void>((resolve) => squatter.listen(first, "127.0.0.1", resolve));
    try {
      start();
      const second = portOf(await ensureAppOrigin("alpha"));
      expect(second).not.toBe(first);
      expect(book()).toEqual({ ports: { alpha: second }, retired: [first] });
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

describe("the cap on open listeners", () => {
  it("closes the least recently used, which reopens on its own port", async () => {
    const ids = Array.from({ length: MAX_OPEN_APP_ORIGINS + 1 }, (_, i) => `app-${i}`);
    for (const id of ids) existing.add(id);
    const first = await ensureAppOrigin(ids[0]);
    for (const id of ids.slice(1)) await ensureAppOrigin(id);
    expect(appOriginIfOpen(ids[0])).toBeNull();
    expect(appOriginIfOpen(ids[1])).not.toBeNull();
    expect(agentOriginPorts()).toHaveLength(MAX_OPEN_APP_ORIGINS);
    expect(await ensureAppOrigin(ids[0])).toBe(first);
    expect(appOriginIfOpen(ids[1])).toBeNull();
  });
});

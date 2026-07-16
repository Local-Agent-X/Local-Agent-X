import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright";
import { configSchema } from "../config-schema.js";
import { setRuntimeConfig } from "../config.js";
import { CHROME_PROFILE_LOCKS, launchViaCDP } from "./launcher.js";
import { startBrowserEgressProxy } from "./egress-proxy.js";
import { closeAllBrowsers, closeBrowser, getCdpBrowserManager } from "./instance.js";
import { browserAvailable } from "./test-browser-available.js";

interface IdentityState {
  cookie: string;
  local: string | null;
  session: string | null;
  indexedDb: string | undefined;
  cache: string | undefined;
}

let fixtureServer: Server;
let fixtureOrigin: string;
let dataDir: string;
let previousPort: string | undefined;
let previousDataDir: string | undefined;
let previousHeadless: string | undefined;
let serviceWorkerRequests = 0;
let runtimeConfigInput: Record<string, unknown>;

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function fixtureHtml(identity: string): string {
  const extra = identity.startsWith("alice")
    ? '<input aria-label="alice-only" value="private">'
    : "";
  return `<!doctype html>
    <title>${identity}</title>
    ${extra}
    <button id="act" onclick="document.querySelector('#result').textContent='clicked-${identity}'">Act ${identity}</button>
    <output id="result">untouched-${identity}</output>`;
}

async function startFixture(): Promise<number> {
  fixtureServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    if (url.pathname === "/sw.js") {
      serviceWorkerRequests++;
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("self.addEventListener('fetch', () => {});");
      return;
    }
    if (url.pathname === "/whoami") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        cookie: request.headers.cookie ?? "",
        via: request.headers.via ?? "",
      }));
      return;
    }
    const identity = url.searchParams.get("identity") ?? "anonymous";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml(identity));
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", resolve);
  });
  const address = fixtureServer.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return address.port;
}

async function writeIdentity(page: Page, identity: string) {
  return page.evaluate(async (value) => {
    const g = globalThis as any;
    g.document.cookie = `auth=${value}; Path=/; SameSite=Lax`;
    g.localStorage.setItem("identity", value);
    g.sessionStorage.setItem("identity", value);
    await new Promise<void>((resolve, reject) => {
      const request = g.indexedDB.open("identity-db", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("markers");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction("markers", "readwrite");
        transaction.objectStore("markers").put(value, "authenticated-user");
        transaction.oncomplete = () => { request.result.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    const identityCache = await g.caches.open("identity-cache");
    await identityCache.put("/identity-cache-marker", new g.Response(value));
    let serviceWorker: string;
    try {
      await g.navigator.serviceWorker.register("/sw.js");
      serviceWorker = "registered";
    } catch (error) {
      serviceWorker = `blocked:${error instanceof Error ? error.name : "error"}`;
    }
    const serverIdentity = await g.fetch("/whoami").then((response: any) => response.json());
    return { serviceWorker, serviceWorkerControlled: Boolean(g.navigator.serviceWorker.controller), serverIdentity };
  }, identity);
}

async function readIdentity(page: Page): Promise<IdentityState> {
  return page.evaluate(async () => {
    const g = globalThis as any;
    const indexedDb = await new Promise<string | undefined>((resolve, reject) => {
      const request = g.indexedDB.open("identity-db", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const transaction = request.result.transaction("markers", "readonly");
        const get = transaction.objectStore("markers").get("authenticated-user");
        get.onsuccess = () => { request.result.close(); resolve(get.result); };
        get.onerror = () => reject(get.error);
      };
    });
    const cacheResponse = await g.caches.match("/identity-cache-marker");
    return {
      cookie: g.document.cookie,
      local: g.localStorage.getItem("identity"),
      session: g.sessionStorage.getItem("identity"),
      indexedDb,
      cache: cacheResponse ? await cacheResponse.text() : undefined,
    };
  });
}

beforeAll(async () => {
  previousPort = process.env.LAX_PORT;
  previousDataDir = process.env.LAX_DATA_DIR;
  previousHeadless = process.env.LAX_BROWSER_HEADLESS;
  dataDir = mkdtempSync(join(tmpdir(), "lax-browser-whole-system-"));
  mkdirSync(join(dataDir, "workspace"), { recursive: true });
  const fixturePort = await startFixture();
  const cdpPort = await unusedPort();
  fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
  process.env.LAX_PORT = String(fixturePort);
  process.env.LAX_DATA_DIR = dataDir;
  process.env.LAX_BROWSER_HEADLESS = "1";
  runtimeConfigInput = {
    port: fixturePort,
    browserCdpPort: cdpPort,
    browserIdleTimeoutMs: 60_000,
    workspace: join(dataDir, "workspace"),
  };
  setRuntimeConfig(configSchema.parse(runtimeConfigInput));
});

afterAll(async () => {
  await closeAllBrowsers();
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  if (previousPort === undefined) delete process.env.LAX_PORT;
  else process.env.LAX_PORT = previousPort;
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  if (previousHeadless === undefined) delete process.env.LAX_BROWSER_HEADLESS;
  else process.env.LAX_BROWSER_HEADLESS = previousHeadless;
});

describe.skipIf(!browserAvailable()).sequential("whole-system browser identity isolation", () => {
  it("runs the production CDP profile path and reaps its process, locks, and disposable profile", async () => {
    const profileDir = join(dataDir, "cdp-profile-test");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "profile-seed.txt"), "persistent-profile");
    for (const lock of CHROME_PROFILE_LOCKS) writeFileSync(join(profileDir, lock), "stale-lock");
    const proxy = await startBrowserEgressProxy();
    const cdpPort = await unusedPort();
    let launch: Awaited<ReturnType<typeof launchViaCDP>> | undefined;
    let pid: number | undefined;
    try {
      launch = await launchViaCDP(await import("playwright"), proxy.url, {
        executablePath: chromium.executablePath(),
        userDataDir: profileDir,
        cdpPort,
        headless: true,
        forceProfileLaunch: true,
        removeProfileOnCleanup: true,
        readyAttempts: 50,
      });
      pid = launch.chromeProcess?.pid;
      expect(pid).toBeTypeOf("number");
      expect(existsSync(join(profileDir, "profile-seed.txt"))).toBe(true);
      expect(CHROME_PROFILE_LOCKS.some((lock) => {
        try { return readFileSync(join(profileDir, lock), "utf8") === "stale-lock"; }
        catch { return false; }
      })).toBe(false);

      const context = await launch.browser.newContext();
      const page = await context.newPage();
      await page.goto(`${fixtureOrigin}/?identity=cdp-profile`);
      expect(await page.evaluate(() => fetch("/whoami").then((response) => response.json())))
        .toMatchObject({ via: "1.1 lax-browser-egress" });
      await context.close();
    } finally {
      await launch?.browser.close().catch(() => undefined);
      await launch?.cleanup?.();
      await proxy.close();
    }

    expect(() => process.kill(pid!, 0)).toThrow();
    expect(existsSync(profileDir)).toBe(false);
  }, 45_000);

  it("isolates simultaneous sessions through the first-launch allocation race", async () => {
    setRuntimeConfig(configSchema.parse(runtimeConfigInput));
    // The default is in-app; on this CDP path (getCdpBrowserManager) in-app is
    // interpreted as isolated (ephemeral-per-session), which is exactly the
    // isolation this test asserts below.
    expect(configSchema.parse({}).browserMode).toBe("in-app");
    const alice = getCdpBrowserManager("alice");
    const bob = getCdpBrowserManager("bob");

    const [alicePage, bobPage] = await Promise.all([alice.getPage(), bob.getPage()]);
    expect(alicePage.context()).not.toBe(bobPage.context());
    await Promise.all([
      alicePage.goto(`${fixtureOrigin}/?identity=alice`),
      bobPage.goto(`${fixtureOrigin}/?identity=bob`),
    ]);
    const [aliceWrite, bobWrite] = await Promise.all([
      writeIdentity(alicePage, "alice-auth"),
      writeIdentity(bobPage, "bob-auth"),
    ]);

    expect(aliceWrite.serverIdentity).toEqual({
      cookie: "auth=alice-auth",
      via: "1.1 lax-browser-egress",
    });
    expect(bobWrite.serverIdentity).toEqual({
      cookie: "auth=bob-auth",
      via: "1.1 lax-browser-egress",
    });
    expect(["registered", "blocked:Error", "blocked:SecurityError"]).toContain(aliceWrite.serviceWorker);
    expect(["registered", "blocked:Error", "blocked:SecurityError"]).toContain(bobWrite.serviceWorker);
    expect(aliceWrite.serviceWorkerControlled).toBe(false);
    expect(bobWrite.serviceWorkerControlled).toBe(false);
    expect(serviceWorkerRequests).toBe(0);
    expect(await readIdentity(alicePage)).toEqual({
      cookie: "auth=alice-auth", local: "alice-auth", session: "alice-auth",
      indexedDb: "alice-auth", cache: "alice-auth",
    });
    expect(await readIdentity(bobPage)).toEqual({
      cookie: "auth=bob-auth", local: "bob-auth", session: "bob-auth",
      indexedDb: "bob-auth", cache: "bob-auth",
    });

    const [aliceObservation, bobObservation] = await Promise.all([alice.observe(), bob.observe()]);
    const aliceRef = aliceObservation.currentRefs.find((ref) => ref.name === "Act alice");
    const bobRef = bobObservation.currentRefs.find((ref) => ref.name === "Act bob");
    expect(aliceRef).toBeDefined();
    expect(bobRef).toBeDefined();
    expect(aliceRef!.id).not.toBe(bobRef!.id);
    expect((await alice.clickByRef(aliceRef!.id)).ok).toBe(true);
    expect(await bobPage.locator("#result").textContent()).toBe("untouched-bob");

    await alice.newTab(`${fixtureOrigin}/?identity=alice-second`);
    expect(alice.listOwnedPages()).toHaveLength(2);
    expect(bob.listOwnedPages()).toHaveLength(1);
    expect(bobPage.url()).toBe(`${fixtureOrigin}/?identity=bob`);

    await closeBrowser("alice");
    expect(await bobPage.title()).toBe("bob");
    expect(await readIdentity(bobPage)).toMatchObject({ local: "bob-auth", indexedDb: "bob-auth" });
    await closeBrowser("bob");
  }, 60_000);

  it("hands continuity to one owner at a time without a stale-owner close failure", async () => {
    setRuntimeConfig(configSchema.parse({ ...runtimeConfigInput, browserMode: "continuity" }));
    const first = getCdpBrowserManager("owner-a");
    const firstPage = await first.getPage();
    await firstPage.goto(`${fixtureOrigin}/?identity=continuity-a`);
    await writeIdentity(firstPage, "continuity-a");

    const second = getCdpBrowserManager("owner-b");
    const secondPage = await second.getPage();
    expect(secondPage.context()).not.toBe(firstPage.context());
    await second.navigate(`${fixtureOrigin}/?identity=continuity-b`);
    expect(await readIdentity(secondPage)).toEqual({
      cookie: "auth=continuity-a", local: "continuity-a", session: null,
      indexedDb: "continuity-a", cache: "continuity-a",
    });
    await expect(closeBrowser("owner-a")).resolves.toBeUndefined();
    await writeIdentity(secondPage, "continuity-b");
    await closeBrowser("owner-b");

    const third = getCdpBrowserManager("owner-c");
    const thirdPage = await third.getPage();
    await third.navigate(`${fixtureOrigin}/?identity=continuity-c`);
    expect(await readIdentity(thirdPage)).toMatchObject({
      cookie: "auth=continuity-b", local: "continuity-b",
      indexedDb: "continuity-b", cache: "continuity-b",
    });
    await closeBrowser("owner-c");
  }, 30_000);

  it("shares identity only in advanced-shared and survives one manager closing", async () => {
    setRuntimeConfig(configSchema.parse({ ...runtimeConfigInput, browserMode: "advanced-shared" }));
    const alice = getCdpBrowserManager("shared-alice");
    const bob = getCdpBrowserManager("shared-bob");
    const [alicePage, bobPage] = await Promise.all([alice.getPage(), bob.getPage()]);
    expect(alicePage.context()).toBe(bobPage.context());
    await Promise.all([
      alicePage.goto(`${fixtureOrigin}/?identity=shared-alice`),
      bobPage.goto(`${fixtureOrigin}/?identity=shared-bob`),
    ]);

    await writeIdentity(alicePage, "shared-alice");
    expect(await readIdentity(bobPage)).toMatchObject({
      cookie: "auth=shared-alice", local: "shared-alice",
      indexedDb: "shared-alice", cache: "shared-alice",
    });
    await writeIdentity(bobPage, "shared-bob");
    expect(await readIdentity(alicePage)).toMatchObject({
      cookie: "auth=shared-bob", local: "shared-bob", session: "shared-alice",
      indexedDb: "shared-bob", cache: "shared-bob",
    });

    await closeBrowser("shared-alice");
    expect(await bobPage.title()).toBe("shared-bob");
    expect(await readIdentity(bobPage)).toMatchObject({ local: "shared-bob", session: "shared-bob" });
    await closeBrowser("shared-bob");
  }, 30_000);
});

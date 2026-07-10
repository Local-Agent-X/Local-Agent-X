import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "playwright";
import { configSchema } from "../config-schema.js";
import { setRuntimeConfig } from "../config.js";
import { BrowserManager } from "./manager.js";
import {
  acquireSessionContext,
  closeSharedBrowser,
  releaseSessionContext,
} from "./runtime.js";

interface IdentityState {
  cookie: string;
  local: string | null;
  session: string | null;
  indexedDb: string | undefined;
}

let fixtureServer: Server;
let fixtureOrigin: string;
let dataDir: string;
let previousPort: string | undefined;
let previousDataDir: string | undefined;
let previousHeadless: string | undefined;
let serviceWorkerRequests = 0;

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
    return {
      cookie: g.document.cookie,
      local: g.localStorage.getItem("identity"),
      session: g.sessionStorage.getItem("identity"),
      indexedDb,
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
  setRuntimeConfig(configSchema.parse({
    port: fixturePort,
    browserCdpPort: cdpPort,
    browserIdleTimeoutMs: 60_000,
    workspace: join(dataDir, "workspace"),
  }));
});

afterAll(async () => {
  await closeSharedBrowser();
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  if (previousPort === undefined) delete process.env.LAX_PORT;
  else process.env.LAX_PORT = previousPort;
  if (previousDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = previousDataDir;
  if (previousHeadless === undefined) delete process.env.LAX_BROWSER_HEADLESS;
  else process.env.LAX_BROWSER_HEADLESS = previousHeadless;
});

describe.sequential("whole-system browser identity isolation", () => {
  it("isolates simultaneous sessions through the first-launch allocation race", async () => {
    const alice = new BrowserManager("alice", "isolated");
    const bob = new BrowserManager("bob", "isolated");

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
      cookie: "auth=alice-auth", local: "alice-auth", session: "alice-auth", indexedDb: "alice-auth",
    });
    expect(await readIdentity(bobPage)).toEqual({
      cookie: "auth=bob-auth", local: "bob-auth", session: "bob-auth", indexedDb: "bob-auth",
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

    await alice.close();
    expect(await bobPage.title()).toBe("bob");
    expect(await readIdentity(bobPage)).toMatchObject({ local: "bob-auth", indexedDb: "bob-auth" });
    await bob.close();
  }, 60_000);

  it("hands continuity to one owner at a time without a stale-owner close failure", async () => {
    const first = await acquireSessionContext("chromium", "continuity", "owner-a");
    const firstPage = await first.newPage();
    await firstPage.goto(`${fixtureOrigin}/?identity=continuity-a`);
    await writeIdentity(firstPage, "continuity-a");

    const second = await acquireSessionContext("chromium", "continuity", "owner-b");
    expect(second).not.toBe(first);
    const secondPage = await second.newPage();
    await secondPage.goto(`${fixtureOrigin}/?identity=continuity-b`);
    expect(await readIdentity(secondPage)).toEqual({
      cookie: "auth=continuity-a", local: "continuity-a", session: null, indexedDb: "continuity-a",
    });
    await expect(releaseSessionContext(first, "continuity")).resolves.toBeUndefined();
    await writeIdentity(secondPage, "continuity-b");
    await releaseSessionContext(second, "continuity");

    const third = await acquireSessionContext("chromium", "continuity", "owner-c");
    const thirdPage = await third.newPage();
    await thirdPage.goto(`${fixtureOrigin}/?identity=continuity-c`);
    expect(await readIdentity(thirdPage)).toMatchObject({
      cookie: "auth=continuity-b", local: "continuity-b", indexedDb: "continuity-b",
    });
    await releaseSessionContext(third, "continuity");
  }, 30_000);

  it("shares identity only in advanced-shared and survives one manager closing", async () => {
    const alice = new BrowserManager("shared-alice", "advanced-shared");
    const bob = new BrowserManager("shared-bob", "advanced-shared");
    const [alicePage, bobPage] = await Promise.all([alice.getPage(), bob.getPage()]);
    expect(alicePage.context()).toBe(bobPage.context());
    await Promise.all([
      alicePage.goto(`${fixtureOrigin}/?identity=shared-alice`),
      bobPage.goto(`${fixtureOrigin}/?identity=shared-bob`),
    ]);

    await writeIdentity(alicePage, "shared-alice");
    expect(await readIdentity(bobPage)).toMatchObject({
      cookie: "auth=shared-alice", local: "shared-alice", indexedDb: "shared-alice",
    });
    await writeIdentity(bobPage, "shared-bob");
    expect(await readIdentity(alicePage)).toMatchObject({
      cookie: "auth=shared-bob", local: "shared-bob", session: "shared-alice", indexedDb: "shared-bob",
    });

    await alice.close();
    expect(await bobPage.title()).toBe("shared-bob");
    expect(await readIdentity(bobPage)).toMatchObject({ local: "shared-bob", session: "shared-bob" });
    await bob.close();
  }, 30_000);
});

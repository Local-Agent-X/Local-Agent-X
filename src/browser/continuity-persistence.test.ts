import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type Page } from "playwright";
import { persistBrowserContextState } from "./runtime.js";
import { browserAvailable } from "./test-browser-available.js";

declare const indexedDB: { open(name: string, version: number): any };

let browser: Browser | null = null;
let server: Server | null = null;
let dataDir: string | null = null;

async function startOrigin(): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>continuity</title>");
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function writeIndexedDbToken(page: Page, token: string): Promise<void> {
  await page.evaluate((value) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("agent-auth", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("tokens");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction("tokens", "readwrite");
      transaction.objectStore("tokens").put(value, "session");
      transaction.oncomplete = () => { request.result.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }), token);
}

async function readIndexedDbToken(page: Page): Promise<string | undefined> {
  return page.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open("agent-auth", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction("tokens", "readonly");
      const get = transaction.objectStore("tokens").get("session");
      get.onsuccess = () => { request.result.close(); resolve(get.result); };
      get.onerror = () => reject(get.error);
    };
  }));
}

afterEach(async () => {
  if (browser) await browser.close();
  browser = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

describe.skipIf(!browserAvailable())("continuity IndexedDB persistence", () => {
  it("survives owner handoff and a full local Chromium restart", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "browser-continuity-idb-"));
    const statePath = join(dataDir, "state.json");
    const origin = await startOrigin();

    browser = await chromium.launch({ headless: true });
    const firstOwner = await browser.newContext();
    const firstPage = await firstOwner.newPage();
    await firstPage.goto(origin);
    await writeIndexedDbToken(firstPage, "owner-a-token");
    await persistBrowserContextState(firstOwner, statePath);
    await firstOwner.close();

    const handoffOwner = await browser.newContext({ storageState: statePath });
    const handoffPage = await handoffOwner.newPage();
    await handoffPage.goto(origin);
    expect(await readIndexedDbToken(handoffPage)).toBe("owner-a-token");
    await writeIndexedDbToken(handoffPage, "owner-b-token");
    await persistBrowserContextState(handoffOwner, statePath);
    await handoffOwner.close();

    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved.cookies).toEqual([]);
    expect(saved.origins[0]?.indexedDB).toBeDefined();

    await browser.close();
    browser = await chromium.launch({ headless: true });
    const restartedOwner = await browser.newContext({ storageState: statePath });
    const restartedPage = await restartedOwner.newPage();
    await restartedPage.goto(origin);
    expect(await readIndexedDbToken(restartedPage)).toBe("owner-b-token");
  }, 30_000);
});

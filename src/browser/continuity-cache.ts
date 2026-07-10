import type { BrowserContext, Page } from "playwright";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const RESTORE_PROMISE = "__laxContinuityCacheRestore";
const MAX_CACHE_ENTRIES = 100;
const MAX_RESPONSE_BYTES = 1024 * 1024;

interface CachedEntry {
  url: string;
  headers: Array<[string, string]>;
  status: number;
  statusText: string;
  responseHeaders: Array<[string, string]>;
  body: number[];
}

interface OriginCacheState {
  origin: string;
  caches: Array<{ name: string; entries: CachedEntry[] }>;
}

interface ContinuityCacheState {
  version: 1;
  origins: OriginCacheState[];
}

async function snapshotOrigin(page: Page): Promise<OriginCacheState | null> {
  return page.evaluate(async ({ maxEntries, maxBytes }) => {
    const g = globalThis as any;
    if (!g.caches || !/^https?:$/.test(g.location.protocol)) return null;
    const result: OriginCacheState = { origin: g.location.origin, caches: [] };
    let count = 0;
    for (const name of await g.caches.keys()) {
      const cache = await g.caches.open(name);
      const entries: CachedEntry[] = [];
      for (const request of await cache.keys()) {
        if (count >= maxEntries) break;
        const response = await cache.match(request);
        if (!response) continue;
        if (response.status < 200 || response.status > 599) continue;
        const bytes = new Uint8Array(await response.clone().arrayBuffer());
        if (bytes.byteLength > maxBytes) continue;
        entries.push({
          url: request.url,
          headers: [...request.headers.entries()],
          status: response.status,
          statusText: response.statusText,
          responseHeaders: [...response.headers.entries()],
          body: Array.from(bytes),
        });
        count++;
      }
      result.caches.push({ name, entries });
      if (count >= maxEntries) break;
    }
    return result;
  }, { maxEntries: MAX_CACHE_ENTRIES, maxBytes: MAX_RESPONSE_BYTES });
}

export async function persistContinuityCacheState(
  context: BrowserContext,
  statePath: string,
): Promise<void> {
  const byOrigin = new Map<string, Page>();
  for (const page of context.pages()) {
    try {
      const origin = new URL(page.url()).origin;
      if (origin !== "null" && !byOrigin.has(origin)) byOrigin.set(origin, page);
    } catch { /* about:blank or a transient navigation */ }
  }
  const origins = (await Promise.all([...byOrigin.values()].map(snapshotOrigin)))
    .filter((state): state is OriginCacheState => state !== null);
  const tempPath = `${statePath}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify({ version: 1, origins } satisfies ContinuityCacheState), {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, statePath);
  } catch (error) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* best-effort */ }
    throw error;
  }
}

export async function installContinuityCacheRestore(
  context: BrowserContext,
  statePath: string,
): Promise<void> {
  if (!existsSync(statePath)) return;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as ContinuityCacheState;
  if (state.version !== 1 || !Array.isArray(state.origins)) return;
  await context.addInitScript(({ snapshot, promiseName }) => {
    const g = globalThis as any;
    const origin = snapshot.origins.find((candidate) => candidate.origin === g.location.origin);
    if (!origin || !g.caches) return;
    const restore = (async () => {
      for (const savedCache of origin.caches) {
        const cache = await g.caches.open(savedCache.name);
        for (const entry of savedCache.entries) {
          try {
            const request = new g.Request(entry.url, { method: "GET", headers: entry.headers });
            const response = new g.Response(new Uint8Array(entry.body), {
              status: entry.status,
              statusText: entry.statusText,
              headers: entry.responseHeaders,
            });
            await cache.put(request, response);
          } catch { /* one unsupported response must not block the remaining cache */ }
        }
      }
    })();
    Object.defineProperty(g, promiseName, { value: restore, configurable: true });
  }, { snapshot: state, promiseName: RESTORE_PROMISE });
}

export async function waitForContinuityCacheRestore(page: Page): Promise<void> {
  await page.evaluate(async (promiseName) => {
    const restore = (globalThis as any)[promiseName];
    if (restore) await restore;
  }, RESTORE_PROMISE);
}

/**
 * Seam: the three-pass Apps-grid list (buildAppList).
 *
 * Regression for the "full-stack app is invisible in the grid" bug — a Next.js /
 * Vite app has NO root index.html and NO registry def.json, so passes 1 and 2
 * both skip it; only its dev-server record marks it on disk. Before the third
 * pass, such an app never appeared as a card no matter how many restarts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAppList, type AppListDeps } from "./apps-list.js";

let wsRoot: string;
let wsAppsDir: string;

beforeEach(() => {
  wsRoot = mkdtempSync(join(tmpdir(), "apps-list-"));
  wsAppsDir = join(wsRoot, "apps");
  mkdirSync(wsAppsDir, { recursive: true });
});

afterEach(() => {
  rmSync(wsRoot, { recursive: true, force: true });
});

function baseDeps(over: Partial<AppListDeps> = {}): AppListDeps {
  return {
    listRegistry: () => [],
    hasDevServer: () => false,
    listDevServers: () => [],
    pins: [],
    wsAppsDir,
    port: 7007,
    now: () => 1_700_000_000_000,
    ...over,
  };
}

describe("buildAppList — full-stack app (pass 3)", () => {
  it("surfaces a Next.js app with a dev-server record but no index.html and no def.json", () => {
    // A full-stack app on disk: real project files, but NO root index.html.
    const appDir = join(wsAppsDir, "ai-video-stitch-next");
    mkdirSync(join(appDir, "src"), { recursive: true });
    writeFileSync(join(appDir, "next.config.js"), "module.exports = {};");
    writeFileSync(join(appDir, "package.json"), "{}");

    const list = buildAppList(baseDeps({
      // Registry is empty (no def.json), workspace HTML scan finds no index.html —
      // the app is discoverable ONLY through its dev-server record.
      listDevServers: () => [{ appId: "ai-video-stitch-next" }],
    }));

    const card = list.find(a => a.id === "ai-video-stitch-next");
    expect(card).toBeDefined();
    expect(card!.name).toBe("Ai Video Stitch Next");
    expect(card!.description).toBe("Full-stack app");
    expect(card!.hasBackend).toBe(true);
    // Opens at the reverse-proxy route with NO trailing slash — a Next.js
    // basePath app 308-redirects the trailing-slash form, which broke the
    // desktop popup (opened → hit 308 → closed). No /index.html either.
    expect(card!.url).toBe("http://127.0.0.1:7007/apps/ai-video-stitch-next");
    expect(card!.url.endsWith("/")).toBe(false);
  });

  it("skips a dev-server record whose workspace folder is gone (stale record)", () => {
    const list = buildAppList(baseDeps({
      listDevServers: () => [{ appId: "deleted-app" }],
    }));
    expect(list.find(a => a.id === "deleted-app")).toBeUndefined();
  });

  it("does not double-list an app already surfaced as an HTML app", () => {
    // Same id has BOTH a root index.html and a dev-server record — pass 2 claims
    // it first (as an HTML app); pass 3 must not add a duplicate.
    const appDir = join(wsAppsDir, "hybrid");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "index.html"), "<h1>hi</h1>");

    const list = buildAppList(baseDeps({
      hasDevServer: (id) => id === "hybrid",
      listDevServers: () => [{ appId: "hybrid" }],
    }));

    const matches = list.filter(a => a.id === "hybrid");
    expect(matches).toHaveLength(1);
    expect(matches[0].description).toBe("HTML app");  // pass 2 wins
  });
});

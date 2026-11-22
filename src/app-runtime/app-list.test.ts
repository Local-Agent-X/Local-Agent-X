/**
 * Seam: the three-pass app list (buildAppList), and the one answer the Apps
 * page and the agent's app_list tool both give (listBuiltApps).
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
import { buildAppList, listBuiltApps, type AppListDeps } from "./app-list.js";
import type { AppDefinition } from "./types.js";
import { appListLine } from "../tools/app-tools/lifecycle.js";

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

// The agent named the app "Through Her Eyes" in its page and the folder
// "blurry-vision"; the grid showed the folder, so the user looked for the wrong name.
describe("buildAppList — a workspace HTML app's name", () => {
  it("is the page's own title", () => {
    mkdirSync(join(wsAppsDir, "blurry-vision"), { recursive: true });
    writeFileSync(join(wsAppsDir, "blurry-vision", "index.html"), "<html><head>\n  <title>\n Through Her Eyes </title></head></html>");
    expect(buildAppList(baseDeps()).find(a => a.id === "blurry-vision")?.name).toBe("Through Her Eyes");
  });

  it("is the folder's name when the page has no title", () => {
    mkdirSync(join(wsAppsDir, "habit-tracker"), { recursive: true });
    writeFileSync(join(wsAppsDir, "habit-tracker", "index.html"), "<h1>hi</h1><title></title>");
    expect(buildAppList(baseDeps()).find(a => a.id === "habit-tracker")?.name).toBe("Habit Tracker");
  });
});

// The Apps page and the agent must name the same apps. The tool read the
// registry alone, so an app that is only a folder in the workspace, which is
// what building one for the user makes, was on the page and unknown to the agent.
describe("listBuiltApps — what the Apps page and app_list both show", () => {
  const registered = {
    id: "budget", name: "Budget", description: "Monthly budget", components: [{}, {}], layout: { type: "grid" },
    status: "paused", version: 3, updatedAt: 1, permissions: { visibility: "private" },
  } as unknown as AppDefinition;

  function workspaceApp(id: string, title: string): void {
    mkdirSync(join(wsAppsDir, id), { recursive: true });
    writeFileSync(join(wsAppsDir, id, "index.html"), `<html><head><title>${title}</title></head></html>`);
  }

  it("lists a workspace folder app beside a registry app, each marked with where it was found", () => {
    workspaceApp("calendar", "Family Calendar");
    const seenActors: Array<string | undefined> = [];
    const apps = listBuiltApps({
      registry: { list: (actor) => { seenActors.push(actor); return [registered]; } },
      actor: "agent", port: 7311, wsAppsDir,
    });
    expect(apps.map((a) => [a.id, a.source])).toEqual([["budget", "registry"], ["calendar", "workspace"]]);
    expect(apps[1]).toMatchObject({ name: "Family Calendar", url: "http://127.0.0.1:7311/apps/calendar/index.html" });
    // The registry is asked as the caller, so its access rules still apply.
    expect(seenActors).toEqual(["agent"]);
  });

  it("gives the agent a line for each, with the id it pins and edits by", () => {
    workspaceApp("calendar", "Family Calendar");
    const lines = listBuiltApps({ registry: { list: () => [registered] }, port: 7311, wsAppsDir }).map(appListLine);
    expect(lines).toEqual([
      "- Budget (budget) [PAUSED] — 2 components, grid layout, v3\n  URL: http://127.0.0.1:7311/apps/budget",
      "- Family Calendar (calendar) — HTML app in workspace/apps/calendar\n  URL: http://127.0.0.1:7311/apps/calendar/index.html",
    ]);
  });

  it("is empty only when neither the registry nor the workspace has an app", () => {
    expect(listBuiltApps({ registry: { list: () => [] }, port: 7311, wsAppsDir })).toEqual([]);
  });
});

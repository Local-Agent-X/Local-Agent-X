/**
 * Offline app bundle + replayed-action idempotency (product flow 5, chunk 8).
 *
 * These are the seam the phone's offline runtime depends on:
 *   - buildAppBundle() must return html + an asset manifest + a state snapshot,
 *     for BOTH a registered app (renderApp) and a workspace HTML app (files on
 *     disk), so the phone can run it with the desktop unreachable.
 *   - updateComponentValues(actionId) must apply a replayed action exactly once,
 *     so a phone draining its offline queue on reconnect never double-applies.
 *
 * LAX_DATA_DIR is set BEFORE importing the runtime so APPS_DIR (a module-load
 * const) points at a throwaway dir, isolating these tests from ~/.lax.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir: string;
let workspace: string;
// Imported after env is set (see beforeAll) so they bind to the throwaway dir.
type RuntimeMod = typeof import("../app-runtime/index.js");
type BundleMod = typeof import("./apps-bundle.js");
let AppRegistry: RuntimeMod["AppRegistry"];
let buildAppBundle: BundleMod["buildAppBundle"];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "bundle-data-"));
  workspace = mkdtempSync(join(tmpdir(), "bundle-ws-"));
  process.env.LAX_DATA_DIR = dataDir;
  ({ AppRegistry } = await import("../app-runtime/index.js"));
  ({ buildAppBundle } = await import("./apps-bundle.js"));
});

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function freshRegistry(): ReturnType<RuntimeMod["AppRegistry"]["getInstance"]> {
  // AppRegistry is a singleton with a private constructor; the singleton is fine
  // here — each test uses a distinct app id.
  return AppRegistry.getInstance();
}

describe("buildAppBundle — registered app", () => {
  it("returns html entry + state snapshot from the renderer", () => {
    const reg = freshRegistry();
    const created = reg.create({
      id: "reg-app-1",
      name: "Counter",
      description: "a registered app",
      components: [{ id: "out", type: "text", props: { text: "0" } }],
      dataBindings: [],
      actions: [],
      events: [],
      layout: { type: "stack" },
      status: "active",
      permissions: { owner: "user", visibility: "team", allowedAgents: [], accessLevels: {} },
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(created.error).toBeUndefined();

    const bundle = buildAppBundle(reg, workspace, "reg-app-1", 7007);
    expect(bundle).not.toBeNull();
    if (!bundle) return;
    expect(bundle.appId).toBe("reg-app-1");
    expect(bundle.entry).toBe("index.html");
    const entry = bundle.files.find((f) => f.path === "index.html");
    expect(entry).toBeDefined();
    expect(entry?.encoding).toBe("utf-8");
    // The renderer's self-contained document: title + the client script.
    expect(entry?.content).toContain("<!DOCTYPE html>");
    expect(entry?.content).toContain("Counter");
    // State snapshot present (created with empty componentValues + metadata).
    expect(bundle.state).not.toBeNull();
    expect(bundle.state?.metadata.version).toBe(1);
  });

  it("returns null for an app that exists nowhere", () => {
    const reg = freshRegistry();
    expect(buildAppBundle(reg, workspace, "does-not-exist", 7007)).toBeNull();
  });
});

describe("buildAppBundle — workspace HTML app", () => {
  it("inlines index.html + referenced assets as a file manifest", () => {
    const appDir = join(workspace, "apps", "ws-app-1");
    mkdirSync(join(appDir, "css"), { recursive: true });
    writeFileSync(join(appDir, "index.html"), "<html><head><link href='css/app.css'></head><body>Hi</body></html>");
    writeFileSync(join(appDir, "css", "app.css"), "body{color:cyan}");

    const reg = freshRegistry();
    const bundle = buildAppBundle(reg, workspace, "ws-app-1", 7007);
    expect(bundle).not.toBeNull();
    if (!bundle) return;
    expect(bundle.entry).toBe("index.html");
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toContain("index.html");
    expect(paths).toContain("css/app.css");
    const css = bundle.files.find((f) => f.path === "css/app.css");
    expect(css?.content).toBe("body{color:cyan}");
    expect(css?.encoding).toBe("utf-8");
  });
});

describe("updateComponentValues — replayed-action idempotency", () => {
  it("applies a tagged action once; a re-send is a no-op (no duplicate, no version bump)", () => {
    const reg = freshRegistry();
    reg.create({
      id: "replay-app-1",
      name: "Replay",
      description: "",
      components: [{ id: "n", type: "text", props: {} }],
      dataBindings: [], actions: [], events: [],
      layout: { type: "stack" },
      status: "active",
      permissions: { owner: "user", visibility: "team", allowedAgents: [], accessLevels: {} },
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
    });

    const before = reg.getState("replay-app-1");
    const baseVersion = before?.metadata.version ?? 0;

    const first = reg.updateComponentValues("replay-app-1", { n: 5 }, "user", "act-A");
    expect(first.error).toBeUndefined();
    expect(first.duplicate).toBeUndefined();
    expect(first.state?.componentValues.n).toBe(5);
    const afterFirst = reg.getState("replay-app-1")?.metadata.version ?? 0;
    expect(afterFirst).toBe(baseVersion + 1);

    // Re-send the SAME action id (a phone retrying the queue) — must dedup.
    const second = reg.updateComponentValues("replay-app-1", { n: 999 }, "user", "act-A");
    expect(second.duplicate).toBe(true);
    const afterSecond = reg.getState("replay-app-1");
    expect(afterSecond?.componentValues.n).toBe(5); // NOT overwritten by the dup
    expect(afterSecond?.metadata.version).toBe(baseVersion + 1); // no extra bump
  });

  it("applies a queue of distinct actions in order, each exactly once", () => {
    const reg = freshRegistry();
    reg.create({
      id: "replay-app-2",
      name: "Queue",
      description: "",
      components: [{ id: "v", type: "text", props: {} }],
      dataBindings: [], actions: [], events: [],
      layout: { type: "stack" },
      status: "active",
      permissions: { owner: "user", visibility: "team", allowedAgents: [], accessLevels: {} },
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
    });

    const queue = [
      { id: "q1", values: { v: "a" } },
      { id: "q2", values: { v: "b" } },
      { id: "q3", values: { v: "c" } },
    ];
    for (const a of queue) reg.updateComponentValues("replay-app-2", a.values, "user", a.id);
    expect(reg.getState("replay-app-2")?.componentValues.v).toBe("c");

    // Re-sync the WHOLE queue (e.g. the phone wasn't sure which landed) — no dup.
    let dupes = 0;
    for (const a of queue) {
      const r = reg.updateComponentValues("replay-app-2", a.values, "user", a.id);
      if (r.duplicate) dupes++;
    }
    expect(dupes).toBe(3);
    expect(reg.getState("replay-app-2")?.componentValues.v).toBe("c");
  });
});

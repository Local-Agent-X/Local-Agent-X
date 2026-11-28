// app_check: the chat's check of an app it built itself. The checks are the
// ones a worker's build passed (verifyBuiltApp); here they are driven through
// the tool with the browser and the judge stubbed.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configMock = vi.hoisted(() => ({ workspace: "" }));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  const { join: joinPath } = await import("node:path");
  return {
    ...actual,
    workspaceRoot: () => configMock.workspace,
    workspacePath: (...segments: string[]) => joinPath(configMock.workspace, ...segments),
  };
});

import { createAppCheckTool } from "./app-check-tool.js";
import { writeAppBuildBrief } from "./build-app.js";
import type { AppVerifyGates } from "../canonical-loop/public/build-adapters.js";

beforeAll(() => { configMock.workspace = mkdtempSync(join(tmpdir(), "lax-app-check-")); });
afterAll(() => { rmSync(configMock.workspace, { recursive: true, force: true }); });

const PAGE = "<!doctype html><html><head><title>Tips</title></head><body><button id=\"go\">Split</button><script>document.getElementById('go').onclick = () => {};</script></body></html>";

function app(name: string, brief?: { prompt: string }): string {
  const dir = join(configMock.workspace, "apps", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), PAGE);
  if (brief) writeAppBuildBrief(dir, { prompt: brief.prompt, tier: "quick-html", newBuild: true, designSpec: "DESIGN: warm, rounded" });
  return dir;
}

/** Gates that never launch a browser, a model or a shell. */
function gates(over: Partial<AppVerifyGates> = {}): AppVerifyGates {
  return {
    structureGate: async () => ({ kind: "skipped" }),
    backendUrlResolver: async () => null,
    smokeGate: async () => ({ verdict: "pass", screenshotPath: "smoke.png", interactionScreenshotPath: "smoke-2.png" }),
    judge: async () => ({ ok: true, reason: "" }),
    ...over,
  };
}

describe("app_check", () => {
  it("returns the app's link once it loaded, survived a click and was judged against the brief", async () => {
    app("tips", { prompt: "a tip splitter" });
    const judged: Array<{ shots: string[]; brief: string; spec?: string }> = [];
    const tool = createAppCheckTool(gates({ judge: async (shots, brief, spec) => { judged.push({ shots, brief, spec }); return { ok: true, reason: "" }; } }));
    const progress: string[] = [];
    const r = await tool.execute({ name: "tips", _sessionId: "chat-1", _onProgress: (line: string) => progress.push(line) }, undefined as never);
    expect(r.isError).toBeFalsy();
    const text = String(r.content);
    expect(text).toContain("APP READY");
    expect(text).toContain("survived a click on its main action");
    expect(text).toMatch(/App URL: http:\/\/127\.0\.0\.1:\d+\/apps\/tips\/index\.html/);
    // The judge saw what build_app was asked for and the design it was given.
    expect(judged).toEqual([{ shots: ["smoke.png", "smoke-2.png"], brief: "a tip splitter", spec: "DESIGN: warm, rounded" }]);
    expect(progress.some((l) => l.startsWith("[verify] smoke passed"))).toBe(true);
  });

  it("says what to fix and withholds the link when the app breaks on load", async () => {
    app("broken", { prompt: "a tip splitter" });
    const tool = createAppCheckTool(gates({ smokeGate: async () => ({ verdict: "fail", detail: "Uncaught TypeError: total is undefined (app.js:12)", screenshotPath: "smoke.png" }) }));
    const r = await tool.execute({ name: "broken" }, undefined as never);
    expect(r.isError).toBe(true);
    const text = String(r.content);
    expect(text).toContain("NOT READY (app_smoke_failed)");
    expect(text).toContain("total is undefined");
    expect(text).toContain("Screenshots: smoke.png");
    expect(text).toContain("call app_check again");
    expect(text).not.toContain("App URL:");
  });

  it("delivers a clean app the judge did not like, with what it noted", async () => {
    app("plain", { prompt: "a tip splitter" });
    const tool = createAppCheckTool(gates({ judge: async () => ({ ok: false, reason: "reads as an unstyled form" }) }));
    const r = await tool.execute({ name: "plain" }, undefined as never);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("The app runs clean.");
    expect(String(r.content)).toContain("reads as an unstyled form");
    expect(String(r.content)).toContain("App URL:");
  });

  it("says nothing opened the app when no browser could, and still gives the link", async () => {
    app("unseen", { prompt: "a tip splitter" });
    const tool = createAppCheckTool(gates({ smokeGate: async () => ({ verdict: "skipped", detail: "no browser is installed", skipKind: "no-browser" }) }));
    const r = await tool.execute({ name: "unseen" }, undefined as never);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("NOT CHECKED: nothing opened the app on this machine. no browser is installed");
    expect(String(r.content)).toContain("App URL:");
  });

  it("checks an app written without build_app, with no brief to judge it against", async () => {
    app("handwritten");
    let judgeCalls = 0;
    const tool = createAppCheckTool(gates({ judge: async () => { judgeCalls++; return { ok: true, reason: "" }; } }));
    const r = await tool.execute({ name: "handwritten" }, undefined as never);
    expect(String(r.content)).toContain("APP READY");
    expect(String(r.content)).toContain("its look was not judged");
    expect(judgeCalls).toBe(0);
  });

  it("refuses a name with no app behind it", async () => {
    const r = await createAppCheckTool(gates()).execute({ name: "nope" }, undefined as never);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain('No app named "nope"');
  });
});

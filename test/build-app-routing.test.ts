/**
 * Routing tests for build_app (Phase 3 of
 * docs/migration/build-app-to-canonical-op.md — flag is gone, canonical
 * path is the only path).
 *
 * Three things this guards:
 *   - resolveBuildProvider normalizes backend args + reads settings.json.
 *   - resolveBuildStrategy reads the right strategy from the app-builder
 *     template's providerStrategy map: every provider → in-canonical-sub-agent
 *     (the default), unless one is explicitly pinned to cli-subprocess.
 *   - buildAppTool.execute sets the app's folder up and returns the build
 *     brief for the chat to build from; it queues no background op.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configMock = vi.hoisted(() => ({ workspace: "" }));
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  const { join: joinPath } = await import("node:path");
  return {
    ...actual,
    workspaceRoot: () => configMock.workspace,
    workspacePath: (...segments: string[]) => joinPath(configMock.workspace, ...segments),
  };
});

import {
  buildAppTool,
  readAppBuildBrief,
  pickForcedProviderFromRuntime,
  resolveBuildProvider,
  resolveBuildStrategy,
} from "../src/tools/build-app.js";
import { designDelivered } from "../src/tools/app-tools/design-gate.js";
import { builderToolsForTier } from "../src/tools/build-app-runtime.js";
import { checkBuildCollision } from "../src/tools/build-app-collision.js";
import { AgentTemplateStore } from "../src/agent-store/index.js";
import { TOOLS } from "../src/tool-registry.js";
import {
  opCancel,
  resetCanonicalRuntime,
  resetScheduler,
} from "../src/canonical-loop/index.js";
import { workspacePath } from "../src/config.js";
import {
  makeInitial as makeOrchestratorState,
  ORCHESTRATOR_STATE_FILENAME,
  write as writeOrchestratorState,
} from "../src/auto-build/orchestrator/state.js";

const submittedOpIds: string[] = [];

beforeAll(() => {
  configMock.workspace = mkdtempSync(join(tmpdir(), "lax-build-app-routing-"));
  // Force the AgentTemplateStore singleton to load the seeded `app-builder`
  // template (its constructor seeds defaults on first instantiation).
  AgentTemplateStore.getInstance();
});

afterEach(() => {
  for (const id of submittedOpIds) {
    try { opCancel(id, "test-cleanup"); } catch { /* swallow */ }
  }
  submittedOpIds.length = 0;
  resetCanonicalRuntime();
  resetScheduler();
});

afterAll(() => {
  rmSync(configMock.workspace, { recursive: true, force: true });
});

describe("resolveBuildProvider — backend arg + settings fallback", () => {
  it("explicit 'codex' backend always wins", () => {
    expect(resolveBuildProvider("codex")).toBe("codex");
  });

  it("'claude' backend normalizes to 'anthropic'", () => {
    expect(resolveBuildProvider("claude")).toBe("anthropic");
  });

  it("missing settings.json falls back to 'anthropic'", () => {
    const fakeSettings = join(tmpdir(), `lax-test-settings-${Date.now()}.json`);
    expect(resolveBuildProvider("auto", { settingsPath: fakeSettings })).toBe("anthropic");
  });

  it("reads provider from a real settings.json", () => {
    const tmp = join(tmpdir(), `lax-test-settings-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({ provider: "qwen" }), "utf-8");
    try {
      expect(resolveBuildProvider("auto", { settingsPath: tmp })).toBe("qwen");
    } finally {
      try { rmSync(tmp); } catch { /* swallow */ }
    }
  });

  it("forcedProvider overrides everything", () => {
    expect(resolveBuildProvider("codex", { forcedProvider: "gemini" })).toBe("gemini");
  });
});

describe("resolveBuildStrategy — template-driven strategy split", () => {
  it("codex provider → in-canonical-sub-agent (template default; CLI dropped after gpt-5.3-codex retired)", () => {
    expect(resolveBuildStrategy("codex")).toBe("in-canonical-sub-agent");
  });

  it("anthropic provider → in-canonical-sub-agent (CLI unpinned; Claude inference runs over the direct-HTTP path)", () => {
    expect(resolveBuildStrategy("anthropic")).toBe("in-canonical-sub-agent");
  });

  it.each(["qwen", "cerebras", "grok", "gemini", "local", "xai"])(
    "%s provider → in-canonical-sub-agent (template default)",
    (provider) => {
      expect(resolveBuildStrategy(provider)).toBe("in-canonical-sub-agent");
    },
  );

  it("unknown providers fall back to the template's default", () => {
    expect(resolveBuildStrategy("future-provider-9000")).toBe("in-canonical-sub-agent");
  });
});

describe("pickForcedProviderFromRuntime — chat-runtime vs. explicit backend", () => {
  it("explicit backend (claude) suppresses the runtime hint — explicit arg wins", () => {
    expect(pickForcedProviderFromRuntime("claude", "codex")).toBeUndefined();
  });

  it("explicit backend (codex) suppresses the runtime hint — even when they would agree", () => {
    expect(pickForcedProviderFromRuntime("codex", "anthropic")).toBeUndefined();
  });

  it("auto backend + runtime set → runtime wins over settings.json", () => {
    expect(pickForcedProviderFromRuntime("auto", "codex")).toBe("codex");
  });

  it("auto backend + no runtime → undefined, falls back to settings.json", () => {
    expect(pickForcedProviderFromRuntime("auto", undefined)).toBeUndefined();
  });

  it("auto backend + empty-string runtime is treated as 'not set'", () => {
    expect(pickForcedProviderFromRuntime("auto", "")).toBeUndefined();
  });
});

describe("build_app — chat-runtime provider plumbing", () => {
  // The full precedence chain assembled at the call-site: chat runtime
  // beats settings.json, but an explicit backend arg beats both.
  it("ctx.runtime wins over settings.json when backend=auto", () => {
    const settingsFile = join(tmpdir(), `lax-runtime-test-${Date.now()}-a.json`);
    writeFileSync(settingsFile, JSON.stringify({ provider: "anthropic" }), "utf-8");
    try {
      const forced = pickForcedProviderFromRuntime("auto", "codex");
      expect(resolveBuildProvider("auto", { settingsPath: settingsFile, forcedProvider: forced })).toBe("codex");
    } finally {
      try { rmSync(settingsFile); } catch { /* swallow */ }
    }
  });

  it("falls back to settings.json when no runtime is provided", () => {
    const settingsFile = join(tmpdir(), `lax-runtime-test-${Date.now()}-b.json`);
    writeFileSync(settingsFile, JSON.stringify({ provider: "anthropic" }), "utf-8");
    try {
      const forced = pickForcedProviderFromRuntime("auto", undefined);
      expect(resolveBuildProvider("auto", { settingsPath: settingsFile, forcedProvider: forced })).toBe("anthropic");
    } finally {
      try { rmSync(settingsFile); } catch { /* swallow */ }
    }
  });

  it("explicit backend=claude wins over ctx.runtime=codex", () => {
    const forced = pickForcedProviderFromRuntime("claude", "codex");
    expect(resolveBuildProvider("claude", forced ? { forcedProvider: forced } : {})).toBe("anthropic");
  });
});

describe("checkBuildCollision — overwrite guard", () => {
  function freshAppDir(): { dir: string; name: string; cleanup: () => void } {
    const name = `collide-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dir = join(tmpdir(), name);
    return { dir, name, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ } } };
  }

  it("no existing index.html → not blocked, not an update", () => {
    const { dir, name, cleanup } = freshAppDir();
    try {
      const r = checkBuildCollision(dir, name, false);
      expect(r.blocked).toBe(false);
      expect(r.isUpdate).toBe(false);
    } finally { cleanup(); }
  });

  it("existing index.html + update:true → not blocked, isUpdate true", () => {
    const { dir, name, cleanup } = freshAppDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), "<html>existing</html>", "utf-8");
      const r = checkBuildCollision(dir, name, true);
      expect(r.blocked).toBe(false);
      expect(r.isUpdate).toBe(true);
    } finally { cleanup(); }
  });

  it("existing index.html + update:false → blocked with a message naming both ways out", () => {
    const { dir, name, cleanup } = freshAppDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), "<html>existing</html>", "utf-8");
      const r = checkBuildCollision(dir, name, false);
      expect(r.blocked).toBe(true);
      expect(r.isUpdate).toBe(false);
      expect(r.errorMessage).toContain("update: true");
      expect(r.errorMessage).toContain(`${name}-v2`);
    } finally { cleanup(); }
  });

  it("spec/plan.md blocks a new Quick Build before it seeds files", async () => {
    const appName = `routing-product-plan-${Date.now()}`;
    const appDir = workspacePath("apps", appName);
    try {
      mkdirSync(join(appDir, "spec"), { recursive: true });
      writeFileSync(join(appDir, "spec", "plan.md"), "# Product plan\n", "utf-8");

      const r = await buildAppTool.execute({
        name: appName,
        prompt: "make a calculator",
        backend: "auto",
        _sessionId: "test-session-product-plan",
      });

      expect(r.isError).toBe(true);
      expect(String(r.content)).toContain("owned by Product Build");
      expect(String(r.content)).toContain("run_build_plan");
      expect(checkBuildCollision(appDir, appName, false).blocked).toBe(true);
      expect(() => readFileSync(join(appDir, "index.html"), "utf-8")).toThrow();
    } finally {
      try { rmSync(appDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  });

  it(`${ORCHESTRATOR_STATE_FILENAME} blocks Quick Build updates and points to status/resume`, async () => {
    const appName = `routing-product-state-${Date.now()}`;
    const appDir = workspacePath("apps", appName);
    try {
      mkdirSync(appDir, { recursive: true });
      writeOrchestratorState(makeOrchestratorState({
        opId: "op-product-build",
        sessionId: "session-product-build",
        projectDir: appDir,
        planPath: join(appDir, "spec", "plan.md"),
        totalChunks: 3,
        startingChunk: 1,
      }));
      writeFileSync(join(appDir, "index.html"), "<html>product build</html>", "utf-8");

      const r = await buildAppTool.execute({
        name: appName,
        prompt: "update the calculator",
        backend: "auto",
        update: true,
        _sessionId: "test-session-product-state",
      });

      expect(r.isError).toBe(true);
      expect(String(r.content)).toContain("owned by Product Build");
      expect(String(r.content)).toContain("build_plan_status");
      expect(String(r.content)).toContain("build_plan_resume");
      expect(readFileSync(join(appDir, "index.html"), "utf-8")).toBe("<html>product build</html>");
    } finally {
      try { rmSync(appDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  });

  it("malformed orchestrator state gives cleanup guidance and unlocks after removal", () => {
    const { dir, name, cleanup } = freshAppDir();
    const marker = join(dir, ORCHESTRATOR_STATE_FILENAME);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(marker, "{}", "utf-8");

      const blocked = checkBuildCollision(dir, name, true);
      expect(blocked.blocked).toBe(true);
      expect(blocked.errorMessage).toContain("malformed or stale");
      expect(blocked.errorMessage).toContain("delete that stale marker");
      expect(blocked.errorMessage).toContain(ORCHESTRATOR_STATE_FILENAME);
      expect(blocked.errorMessage).not.toContain("call build_plan_resume");

      rmSync(marker);
      expect(checkBuildCollision(dir, name, true)).toEqual({ blocked: false, isUpdate: false });
    } finally { cleanup(); }
  });

  it("spec/plan.md stays blocked when a malformed state marker is removed", () => {
    const { dir, name, cleanup } = freshAppDir();
    const marker = join(dir, ORCHESTRATOR_STATE_FILENAME);
    try {
      mkdirSync(join(dir, "spec"), { recursive: true });
      writeFileSync(join(dir, "spec", "plan.md"), "# Product plan\n", "utf-8");
      writeFileSync(marker, "{}", "utf-8");

      const stale = checkBuildCollision(dir, name, true);
      expect(stale.errorMessage).toContain("delete that stale marker");
      expect(stale.errorMessage).toContain("run_build_plan");

      rmSync(marker);
      const planned = checkBuildCollision(dir, name, true);
      expect(planned.blocked).toBe(true);
      expect(planned.errorMessage).toContain("owned by Product Build (spec/plan.md)");
    } finally { cleanup(); }
  });

  it("build_app.execute returns isError when colliding without update flag", async () => {
    const appName = `routing-collide-${Date.now()}`;
    const appDir = workspacePath("apps", appName);
    try {
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, "index.html"), "<html>existing</html>", "utf-8");
      const r = await buildAppTool.execute({
        name: appName,
        prompt: "make a calculator",
        backend: "auto",
        _sessionId: "test-session-collide",
      });
      expect(r.isError).toBe(true);
      expect(String(r.content)).toContain("already exists");
    } finally {
      try { rmSync(appDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  });
});

// Until 2026-11-27 build_app queued a background op and told the chat not to
// build. The owner's call: the chat builds what it is asked for. build_app now
// sets the folder up and hands the chat the builder's brief.
describe("build_app — the chat builds the app itself", () => {
  it("sets up the folder, returns the brief, and queues no background build", async () => {
    const appName = `routing-test-${Date.now()}`;
    const appDir = workspacePath("apps", appName);
    try {
      const r = await buildAppTool.execute({
        name: appName,
        prompt: "A tiny tip calculator with a bill field and a tip slider.",
        _sessionId: "test-session-routing",
      });
      expect(r.isError).toBeFalsy();
      expect(r.metadata?.chip).toBeUndefined();
      const text = String(r.content);
      // The builder's own brief: where the files go, the rules, the design system.
      expect(text).toContain(`You are building a web app in the directory: ${appDir}`);
      expect(text).toContain("A tiny tip calculator");
      expect(text).toContain("BUILD IT YOURSELF, NOW, IN THIS CONVERSATION");
      expect(text).toContain(`app_check({"name": "${appName}"})`);
      // The starter is there to edit, and the brief is kept for the check.
      expect(existsSync(join(appDir, "index.html"))).toBe(true);
      expect(readAppBuildBrief(appDir)).toMatchObject({ prompt: "A tiny tip calculator with a bill field and a tip slider.", tier: "quick-html", newBuild: true });
      // Its UI writes are not held for the design system: the brief carried it.
      expect(designDelivered("test-session-routing", appName)).toBe(true);
    } finally {
      try { rmSync(appDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  });

  it("an update keeps the app's files and is recorded as one", async () => {
    const appName = `routing-update-${Date.now()}`;
    const appDir = workspacePath("apps", appName);
    try {
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, "index.html"), "<html>existing</html>", "utf-8");
      const r = await buildAppTool.execute({ name: appName, prompt: "make the header green", update: true, _sessionId: "test-session-routing" });
      expect(r.isError).toBeFalsy();
      expect(String(r.content)).toContain("Task: UPDATE existing app");
      expect(readFileSync(join(appDir, "index.html"), "utf-8")).toBe("<html>existing</html>");
      expect(readAppBuildBrief(appDir)).toMatchObject({ newBuild: false });
    } finally {
      try { rmSync(appDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  });
});

describe("builderToolsForTier — real-build tiers get the process tools", () => {
  const names = (tier: Parameters<typeof builderToolsForTier>[0]) =>
    builderToolsForTier(tier).map((t) => t.name);

  it("quick-html gets the base toolset, no process_* tools", () => {
    const n = names("quick-html");
    expect(n).toContain("bash");
    expect(n).toContain("connector_create");
    expect(n).not.toContain("process_start");
  });

  it("full-stack adds process tools + the turnkey app_serve_backend primitive", () => {
    const n = names("full-stack");
    expect(n).toContain("process_start");
    expect(n).toContain("process_status");
    expect(n).toContain("process_kill");
    expect(n).toContain("app_serve_backend");
  });

  it("compiled-native adds the process tools but NOT app_serve_backend (no backend)", () => {
    const n = names("compiled-native");
    expect(n).toContain("process_start");
    expect(n).not.toContain("app_serve_backend");
  });

  // Regression for the whole class: a tool handed to the builder but missing
  // from the policy registry (tool-policies.*) makes the ARI kernel fail-closed
  // and BLOCK the call — which is exactly how the full-stack notes build broke
  // (app_serve_backend not in TOOLS). Every tier's toolset must be classified.
  it("every builder tool, for every tier, is classified in the policy registry", () => {
    for (const tier of ["quick-html", "full-stack", "compiled-native"] as const) {
      for (const t of builderToolsForTier(tier)) {
        expect(TOOLS[t.name], `${t.name} (tier=${tier}) is unclassified — the ARI kernel fail-closes and BLOCKS it`).toBeDefined();
      }
    }
  });
});

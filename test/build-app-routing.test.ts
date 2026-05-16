/**
 * Routing tests for build_app (Phase 3 of
 * docs/migration/build-app-to-canonical-op.md — flag is gone, canonical
 * path is the only path).
 *
 * Three things this guards:
 *   - resolveBuildProvider normalizes backend args + reads settings.json.
 *   - resolveBuildStrategy reads the right strategy from the app-builder
 *     template's providerStrategy map: codex / anthropic → cli-subprocess,
 *     everyone else → in-canonical-sub-agent.
 *   - buildAppTool.execute returns the canonical-shape result (op-submitted
 *     chip + opId; the op lands in the store with type "app_build").
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildAppTool,
  resolveBuildProvider,
  resolveBuildStrategy,
  APP_BUILD_OP_TYPE,
} from "../src/tools/build-app.js";
import { AgentTemplateStore } from "../src/agent-store.js";
import { readOp } from "../src/ops/op-store.js";
import {
  opCancel,
  resetCanonicalRuntime,
  resetScheduler,
} from "../src/canonical-loop/index.js";

const submittedOpIds: string[] = [];

afterEach(() => {
  for (const id of submittedOpIds) {
    try { opCancel(id, "test-cleanup"); } catch { /* swallow */ }
  }
  submittedOpIds.length = 0;
  resetCanonicalRuntime();
  resetScheduler();
});

beforeAll(() => {
  // Force the AgentTemplateStore singleton to load the seeded `app-builder`
  // template (its constructor seeds defaults on first instantiation).
  AgentTemplateStore.getInstance();
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
  it("codex provider → cli-subprocess", () => {
    expect(resolveBuildStrategy("codex")).toBe("cli-subprocess");
  });

  it("anthropic provider → cli-subprocess", () => {
    expect(resolveBuildStrategy("anthropic")).toBe("cli-subprocess");
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

describe("build_app — canonical-shape result", () => {
  it("returns the op-submitted chip and lands an op in the store", async () => {
    const appName = `routing-test-${Date.now()}`;
    const r = await buildAppTool.execute({
      name: appName,
      prompt: "A tiny smoke-test app — should queue an op_app_build_* op.",
      backend: "auto",
      _sessionId: "test-session-routing",
    });
    expect(r.isError).toBeFalsy();
    const chip = (r.metadata?.chip ?? {}) as { kind?: string; opId?: string };
    expect(chip.kind).toBe("op-submitted");
    expect(typeof chip.opId).toBe("string");
    expect(chip.opId).toMatch(/^op_app_build_/);
    if (chip.opId) submittedOpIds.push(chip.opId);

    const op = chip.opId ? readOp(chip.opId) : null;
    expect(op?.type).toBe(APP_BUILD_OP_TYPE);

    try { rmSync(resolve("workspace", "apps", appName), { recursive: true, force: true }); } catch { /* swallow */ }
  });
});

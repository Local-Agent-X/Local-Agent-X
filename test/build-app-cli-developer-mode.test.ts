/**
 * build_app's cli-subprocess strategy runs the codex / claude CLI on the host
 * with approvals bypassed and shell access, outside the cage. The strategy is
 * picked by the app-builder template, which the agent can change, so it must
 * not run without developer_mode: build_app refuses at the moment the strategy
 * is chosen (no silent fall back to in-canonical), before the tier classifier
 * spends a model call and before anything is written. The adapter's own
 * spawn-time check is pinned in build-app-adapter.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  workspace: "",
  canonicalLoopEntry: vi.fn(),
  resolveAppTier: vi.fn(async () => "quick-html"),
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  const { join: joinPath } = await import("node:path");
  return {
    ...actual,
    workspaceRoot: () => mocks.workspace,
    workspacePath: (...segments: string[]) => joinPath(mocks.workspace, ...segments),
  };
});
// Queue the op but never lease it: a leased cli-subprocess op would spawn a real CLI.
vi.mock("../src/canonical-loop/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/canonical-loop/index.js")>()),
  canonicalLoopEntry: mocks.canonicalLoopEntry,
}));
vi.mock("../src/tools/app-tier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/app-tier.js")>()),
  resolveAppTier: mocks.resolveAppTier,
}));

const { buildAppTool } = await import("../src/tools/build-app.js");
const { AgentTemplateStore } = await import("../src/agent-store/index.js");
const { setSetting } = await import("../src/settings.js");

let originalStrategy: Record<string, string | undefined> | undefined;

beforeAll(() => {
  mocks.workspace = mkdtempSync(join(tmpdir(), "lax-build-app-cli-devmode-"));
  const store = AgentTemplateStore.getInstance();
  originalStrategy = store.get("app-builder")?.providerStrategy;
  store.update("app-builder", { providerStrategy: { default: "in-canonical-sub-agent", anthropic: "cli-subprocess" } });
});

afterAll(() => {
  AgentTemplateStore.getInstance().update("app-builder", { providerStrategy: originalStrategy });
  rmSync(mocks.workspace, { recursive: true, force: true });
});

afterEach(() => {
  setSetting("developer_mode", false);
  mocks.canonicalLoopEntry.mockClear();
  mocks.resolveAppTier.mockClear();
});

async function build(name: string, backend: string) {
  return buildAppTool.execute({ name, prompt: "a tiny calculator", backend, _sessionId: "devmode-session" });
}

describe("build_app — cli-subprocess strategy requires developer_mode", () => {
  it("refuses with developer_mode off, explains why, and leaves nothing behind", async () => {
    const result = await build("cli-refused", "claude");

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("cli-subprocess");
    expect(String(result.content)).toContain("requires developer_mode");
    expect(String(result.content)).toContain("Nothing was built");
    expect(mocks.resolveAppTier).not.toHaveBeenCalled();
    expect(mocks.canonicalLoopEntry).not.toHaveBeenCalled();
    expect(existsSync(join(mocks.workspace, "apps", "cli-refused"))).toBe(false);
  });

  it("queues the CLI build with developer_mode on", async () => {
    setSetting("developer_mode", true);
    const result = await build("cli-allowed", "claude");

    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain("strategy=cli-subprocess");
    expect(mocks.canonicalLoopEntry).toHaveBeenCalledTimes(1);
  });

  it("leaves in-canonical builds alone with developer_mode off", async () => {
    const result = await build("in-canonical-build", "codex");

    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain("strategy=in-canonical-sub-agent");
    expect(mocks.canonicalLoopEntry).toHaveBeenCalledTimes(1);
  });
});

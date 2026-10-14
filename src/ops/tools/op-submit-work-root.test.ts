// A build-lane submission names the one directory its worker may mutate
// (omitted: the submitting session's own scope), and the submit tools refuse
// — as a tool result, not a harness failure — one outside what that session
// could touch. Stops at buildOpFromArgs for the stored shape, and drives
// op_submit_async's execute for the refusal rendering.

import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "submit-work-root-")));
const WORKSPACE = join(ROOT, "workspace");
mkdirSync(join(WORKSPACE, "apps", "proj"), { recursive: true });
mkdirSync(join(ROOT, "outside"), { recursive: true });

vi.mock("../../config.js", () => ({
  workspaceRoot: () => WORKSPACE,
  uploadsDir: () => join(ROOT, "uploads"),
  getRuntimeConfig: () => ({ workspace: WORKSPACE }),
}));
vi.mock("../../lax-data-dir.js", () => ({ getLaxDir: () => join(ROOT, "lax") }));
vi.mock("../context-pack-builder.js", () => ({
  buildContextPack: async (input: { lane: string; preferredProvider?: string }) => ({
    task: { description: "", successCriteria: [], constraints: [], notWhatToRedo: [] },
    context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
    capabilities: {},
    budget: { maxIterations: 1, maxTokens: 0, maxWallTimeMs: 1, maxSelfEditCalls: 0 },
    routing: { lane: input.lane, preferredProvider: input.preferredProvider },
    secrets: { allowed: [] },
  }),
}));
vi.mock("../session-bridge.js", () => ({
  readRecentSessionMessages: () => [],
  listOpsForSession: () => [],
  trackOpForSession: () => {},
  broadcastToSession: () => {},
}));
vi.mock("../op-store.js", () => ({
  newOpId: (prefix: string) => `${prefix}_test`,
  readOp: () => null,
  isInteractiveHostOpType: () => false,
}));
vi.mock("../../canonical-loop/index.js", () => ({
  awaitOpRunning: async () => ({ running: true }),
  canonicalLoopEntry: () => {},
}));
vi.mock("../../canonical-loop/public/plan-ledger.js", () => ({ isEnforcedPlanMode: () => false }));

const { buildOpFromArgs } = await import("./shared.js");
const { opSubmitAsyncTool } = await import("./op-submit-async.js");

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("build-lane submissions carry a vetted work root", () => {
  it("stores the resolved work root on the op's routing", async () => {
    const op = await buildOpFromArgs({ task: "add a page", lane: "build", work_root: "apps/proj", _sessionId: "chat" });
    expect(op.lane).toBe("build");
    expect(op.contextPack.routing.workRoot).toBe(join(WORKSPACE, "apps", "proj"));
  });

  it("defaults a build submission without one to the submitter's scope — the workspace", async () => {
    const labeled = await buildOpFromArgs({ task: "add a page", lane: "build", _sessionId: "chat" });
    expect(labeled.contextPack.routing.workRoot).toBe(WORKSPACE);
    // The lane default is build, so an unlabeled submission gets the same root.
    const unlabeled = await buildOpFromArgs({ task: "add a page", _sessionId: "chat" });
    expect(unlabeled.contextPack.routing.workRoot).toBe(WORKSPACE);
  });

  it("refuses a work root outside the workspace", async () => {
    await expect(buildOpFromArgs({ task: "x", lane: "build", work_root: join(ROOT, "outside"), _sessionId: "chat" }))
      .rejects.toThrow(/outside the workspace/);
  });

  it("stores nothing for the read-only lanes", async () => {
    const op = await buildOpFromArgs({ task: "summarize", lane: "interactive", work_root: "apps/proj", _sessionId: "chat" });
    expect(op.contextPack.routing.workRoot).toBeUndefined();
  });

  it("op_submit_async renders the refusal as the tool result", async () => {
    const result = await opSubmitAsyncTool.execute({ task: "add a page", lane: "build", work_root: join(ROOT, "outside"), _sessionId: "chat-refusal" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the workspace/);
  });
});

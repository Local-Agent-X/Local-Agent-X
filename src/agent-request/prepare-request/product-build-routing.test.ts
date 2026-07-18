import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../types.js";
import type { AppBuildContinuationResolution } from "../../auto-build/workflow-resolver.js";
import {
  BUILD_ROUTE_QUESTION,
  applyProductBuildToolRoute,
  isProductBuildContinuationRequest,
  productBuildTurnFromIntent,
  resolveProductBuildContinuationTurn,
} from "./product-build-routing.js";
import { selectTools } from "./tool-selection.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {} },
    audiences: ["main-chat", "build-intent"],
    execute: async () => ({ content: "" }),
  };
}

const allTools = [
  "read", "write", "bash", "tool_search", "agent_spawn", "self_edit",
  "build_app", "start_app_build", "finalize_app_build", "run_build_plan",
  "build_plan_status", "build_plan_resume",
].map(tool);

function resolved(
  action: "conversation" | "run_build_plan" | "build_plan_status" | "build_plan_resume",
  phase: "planning" | "finalized" | "running" | "halted" | "complete" = "running",
): Extract<AppBuildContinuationResolution, { kind: "resolved" }> {
  return {
    kind: "resolved",
    action,
    adopted: false,
    candidate: {
      action,
      phase,
      projectDir: "C:\\apps\\crm",
      opId: "op-1",
      sessionIds: ["session-1"],
      resumable: action === "build_plan_resume",
      adoptable: false,
      reason: `state is ${phase}`,
    },
  };
}

function selection(overrides: Partial<Parameters<typeof selectTools>[0]> = {}) {
  return selectTools({
    message: "Build a production CRM with accounts and persistent customer data",
    sessionId: "session-1",
    channel: "web",
    allAgentTools: allTools,
    bridgeTools: [],
    resolvedProvider: "openai",
    resolvedModel: "gpt-5",
    ...overrides,
  });
}

describe("Product Build continuation trigger", () => {
  it.each([
    "continue the build",
    "resume my app build",
    "continue the new build",
    "what is the build status",
    "show progress on the product build",
  ])("recognizes %s", message => {
    expect(isProductBuildContinuationRequest(message)).toBe(true);
  });

  it.each([
    "how are you?",
    "tell me a joke while the build runs",
    "build another app",
    "continue building another app",
    "continue by building a totally different app",
    "continue by building a totally new app",
    "resume with a separate customer portal project",
    "make a new product",
  ])("does not hijack %s", message => {
    expect(isProductBuildContinuationRequest(message)).toBe(false);
  });
});

describe("Quick versus Product route mapping", () => {
  it("maps an explicit quick route to build_app", () => {
    const turn = productBuildTurnFromIntent({
      kind: "build_app", mode: "lean", buildRoute: "quick", reason: "prototype",
    });
    expect(turn).toMatchObject({ kind: "quick", action: "build_app", targetTool: "build_app" });
  });

  it("maps an explicit product route to start_app_build even when lean", () => {
    const turn = productBuildTurnFromIntent({
      kind: "build_app", mode: "lean", buildRoute: "product", reason: "production",
    });
    expect(turn).toMatchObject({ kind: "product", action: "start_app_build", targetTool: "start_app_build" });
  });

  it("maps unclear lifecycle to the one canonical question", () => {
    const turn = productBuildTurnFromIntent({
      kind: "build_app", mode: "lean", buildRoute: "clarify", reason: "unclear",
    });
    expect(turn?.targetTool).toBeUndefined();
    expect(turn?.directive).toContain(BUILD_ROUTE_QUESTION);
    expect(turn?.directive.match(/\?/g)).toHaveLength(1);
  });

  it("removes sibling build tools and re-adds only the exact target", () => {
    const turn = productBuildTurnFromIntent({
      kind: "build_app", mode: "force", buildRoute: "product", reason: "durable",
    });
    const names = applyProductBuildToolRoute(allTools, allTools, turn).map(item => item.name);
    expect(names).toContain("start_app_build");
    expect(names).not.toContain("build_app");
    expect(names).not.toContain("run_build_plan");
  });
});

describe("durable continuation action mapping", () => {
  it.each([
    ["run_build_plan", "finalized"],
    ["build_plan_status", "running"],
    ["build_plan_resume", "halted"],
  ] as const)("maps %s state to its exact tool", (action, phase) => {
    const turn = resolveProductBuildContinuationTurn(
      "continue the build",
      "session-1",
      () => resolved(action, phase),
    );
    expect(turn).toMatchObject({ kind: "continuation", action, targetTool: action });
    expect(turn?.directive).toContain(`action=${action}`);
    expect(turn?.directive).toContain('project_dir="C:/apps/crm"');
  });

  it.each(["planning", "complete"] as const)("keeps %s state conversational", phase => {
    const turn = resolveProductBuildContinuationTurn(
      "continue the product build",
      "session-1",
      () => resolved("conversation", phase),
    );
    expect(turn).toMatchObject({ kind: "continuation", action: "conversation" });
    expect(turn?.targetTool).toBeUndefined();
    expect(turn?.directive).toContain("Do not call build_app");
  });
});

describe("canonical tool selection routing", () => {
  it("exposes and forces only start_app_build for Product Build", async () => {
    const result = await selection({
      classifyIntentFn: async () => ({
        kind: "build_app", mode: "lean", buildRoute: "product", reason: "durable product",
      }),
    });
    const names = result.tools.map(item => item.name);
    expect(result.forcedToolName).toBe("start_app_build");
    expect(names).toContain("start_app_build");
    expect(names).not.toContain("build_app");
    expect(names).not.toContain("write");
  });

  it("exposes and forces only build_app for Quick Build", async () => {
    const result = await selection({
      message: "Prototype a tiny habit tracker demo",
      classifyIntentFn: async () => ({
        kind: "build_app", mode: "lean", buildRoute: "quick", reason: "prototype",
      }),
    });
    const names = result.tools.map(item => item.name);
    expect(result.forcedToolName).toBe("build_app");
    expect(names).toContain("build_app");
    expect(names).not.toContain("start_app_build");
  });

  it("exposes no build mutation tool for clarification", async () => {
    const result = await selection({
      message: "Build me an app",
      classifyIntentFn: async () => ({
        kind: "build_app", mode: "lean", buildRoute: "clarify", reason: "unclear",
      }),
    });
    const names = result.tools.map(item => item.name);
    expect(result.forcedToolName).toBeUndefined();
    expect(names).not.toContain("build_app");
    expect(names).not.toContain("start_app_build");
    expect(result.productBuildTurn?.directive).toContain(BUILD_ROUTE_QUESTION);
  });

  it("resolves continuation before classification and forces status", async () => {
    const classifier = vi.fn(async () => ({
      kind: "build_app" as const, mode: "force" as const, buildRoute: "quick" as const, reason: "wrong",
    }));
    const result = await selection({
      message: "what is the build status",
      classifyIntentFn: classifier,
      continuationResolver: () => resolved("build_plan_status"),
    });
    expect(classifier).not.toHaveBeenCalled();
    expect(result.forcedToolName).toBe("build_plan_status");
    expect(result.tools.map(item => item.name)).toContain("build_plan_status");
    expect(result.tools.map(item => item.name)).not.toContain("build_app");
    expect(result.productBuildTurn?.directive).toContain('project_dir="C:/apps/crm"');
  });

  it("keeps unrelated chat and another-app requests away from the resolver", async () => {
    const resolver = vi.fn(() => resolved("build_plan_status"));
    await selection({
      message: "build another app",
      continuationResolver: resolver,
      classifyIntentFn: async () => ({
        kind: "build_app", mode: "lean", buildRoute: "clarify", reason: "new app",
      }),
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("asks one project question for ambiguous continuation and never guesses", async () => {
    const result = await selection({
      message: "continue the build",
      continuationResolver: () => ({
        kind: "ambiguous",
        action: null,
        candidates: [
          resolved("build_plan_resume", "halted").candidate,
          { ...resolved("run_build_plan", "finalized").candidate, projectDir: "C:\\apps\\billing" },
        ],
      }),
    });
    expect(result.forcedToolName).toBeUndefined();
    expect(result.productBuildTurn?.directive.match(/\?/g)).toHaveLength(1);
    expect(result.tools.map(item => item.name)).not.toContain("build_app");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../types.js";
import type { AppBuildContinuationResolution } from "../../auto-build/workflow-resolver.js";
import {
  applyProductBuildToolRoute,
  isProductBuildContinuationRequest,
  resolveProductBuildContinuationTurn,
} from "./product-build-routing.js";
import { selectTools } from "./tool-selection.js";
import { SLASH_COMMAND_MARKER } from "../../slash-commands.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {} },
    audiences: ["main-chat"],
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

describe("explicit route tool mapping", () => {
  it("removes sibling build tools and re-adds only the exact target", () => {
    const turn = resolveProductBuildContinuationTurn(
      "continue the build",
      "session-1",
      () => resolved("build_plan_resume", "halted"),
    );
    const names = applyProductBuildToolRoute(allTools, allTools, turn).map(item => item.name);
    expect(names).toContain("build_plan_resume");
    expect(names).not.toContain("build_app");
    expect(names).not.toContain("start_app_build");
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
  it("forces /app-build into Product Build and structurally removes Quick Build", async () => {
    const result = await selection({
      message: `${SLASH_COMMAND_MARKER} \`/app-build\`. The user's argument: Build me a CRM`,
    });
    const names = result.tools.map(item => item.name);
    expect(result.forcedToolName).toBe("start_app_build");
    expect(names).toContain("start_app_build");
    expect(names).not.toContain("build_app");
    expect(names).not.toContain("write");
  });

  it("keeps later /app-build planning turns Product-only through sign-off", async () => {
    const result = await selection({
      message: "Everything is locked in",
      priorMethodology: true,
    });
    const names = result.tools.map(item => item.name);
    expect(result.forcedToolName).toBeUndefined();
    expect(names).toContain("start_app_build");
    expect(names).toContain("finalize_app_build");
    expect(names).not.toContain("build_app");
    expect(names).not.toContain("write");
    expect(result.productBuildTurn?.directive).toContain("call finalize_app_build");
  });

  // op-outcomes 2026-09-15: build-shaped wording used to be classified as a
  // build request, which pinned build_app and sent a local model into a
  // 30-minute app build for "And cleanup/logs/build-4.log?".
  it.each([
    "And cleanup/logs/build-4.log?",
    "add a formatPrice function to the pricing app",
    "Build a production CRM with accounts and persistent customer data",
  ])("build-shaped wording without an explicit route never routes tools: %s", async message => {
    const result = await selection({ message });
    const names = result.tools.map(item => item.name);
    expect(result.productBuildTurn).toBeNull();
    expect(result.forcedToolName).toBeUndefined();
    expect(names).toContain("read");
    expect(names).toContain("write");
  });

  it("resolves a continuation request and forces status", async () => {
    const result = await selection({
      message: "what is the build status",
      continuationResolver: () => resolved("build_plan_status"),
    });
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

import { describe, expect, it, vi } from "vitest";
import type { Protocol } from "./types.js";

let __customProtocols: Protocol[] = [];
vi.mock("./builder.js", async () => {
  const actual = await vi.importActual<typeof import("./builder.js")>("./builder.js");
  return { ...actual, loadCustomProtocols: () => __customProtocols };
});

const { createCoreProtocolTools } = await import("./index.js");

function protocolGet() {
  const tool = createCoreProtocolTools().find((candidate) => candidate.name === "protocol_get");
  if (!tool) throw new Error("protocol_get tool not found");
  return tool;
}

describe("protocol_get", () => {
  it("returns the instruction body for prompt-style protocols", async () => {
    const result = await protocolGet().execute({ name: "brownfield" });

    expect(result.content).toContain("# /brownfield — Land changes into an existing codebase");
    expect(result.content).toContain("## Mental model");
    expect(result.content).not.toContain("## STEPS:");
  });

  it("keeps the structured rules and steps for typed protocols", async () => {
    const result = await protocolGet().execute({ name: "git_workflow" });

    expect(result.content).toContain("## RULES (follow these strictly):");
    expect(result.content).toContain("Always check for uncommitted changes before switching branches.");
    expect(result.content).toContain("Step 1 [check_status]: Run git status to see current state.");
    expect(result.content).toContain("Step 6 [verify]: Verify push succeeded. Show remote URL.");
  });

  it("does not flag a built-in/typed protocol as unreviewed", async () => {
    const result = await protocolGet().execute({ name: "git_workflow" });
    expect(result.content).not.toContain("Authored autonomously");
  });

  it("flags a custom protocol the review fork authored on its own initiative", async () => {
    __customProtocols = [{
      name: "agent_minted_skill",
      description: "Minted from one run",
      triggers: [], steps: [], rules: [], learnablePreferences: [],
      body: "# Steps\n1. Do the thing.",
      source: { type: "custom", authoredBy: "agent", authoredAt: 1 },
    }];
    const result = await protocolGet().execute({ name: "agent_minted_skill" });
    expect(result.content).toContain("Authored autonomously by the agent from a single run");
    __customProtocols = [];
  });

  it("does not flag a user-authored custom protocol", async () => {
    __customProtocols = [{
      name: "user_written_skill",
      description: "Written by the user",
      triggers: [], steps: [], rules: [], learnablePreferences: [],
      body: "# Steps\n1. Do the thing.",
      source: { type: "custom", authoredBy: "user", authoredAt: 1 },
    }];
    const result = await protocolGet().execute({ name: "user_written_skill" });
    expect(result.content).not.toContain("Authored autonomously");
    __customProtocols = [];
  });
});

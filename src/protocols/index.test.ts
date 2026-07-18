import { describe, expect, it } from "vitest";
import { createCoreProtocolTools } from "./index.js";

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
});

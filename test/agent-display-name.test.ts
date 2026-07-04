import { describe, expect, it } from "vitest";
import { formatAgentDisplayName, isGeneratedAgentRunName } from "../src/agency/agent-display-name.js";

describe("agent display names", () => {
  it("keeps explicit human names", () => {
    expect(formatAgentDisplayName({
      name: "Harness Auditor",
      role: "researcher",
      task: "audit the harness",
    })).toBe("Harness Auditor");
  });

  it("replaces generated run ids with role and task context", () => {
    expect(isGeneratedAgentRunName("field-agent-2-mr6vnfr0")).toBe(true);
    expect(formatAgentDisplayName({
      name: "field-agent-2-mr6vnfr0",
      role: "researcher",
      task: "Start a background worker to audit the canonical-loop checkpoint behavior.",
    })).toBe("Researcher: audit the canonical-loop checkpoint behavior.");
  });

  it("falls back without exposing generated ids", () => {
    expect(formatAgentDisplayName({
      name: "primal-agent-7-abcd1234",
      role: "field-agent",
      task: "",
    })).toBe("Field");
  });
});

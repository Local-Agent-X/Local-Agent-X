import { describe, expect, it } from "vitest";
import { RuntimeSurfaceMismatchError } from "./agent-runner/runtime-surface-error.js";
import { RuntimeIdentityMismatchError } from "./provider-adapter-factory.js";
import { terminalRuntimeReconstructionCode } from "./runtime-reconstruction.js";

describe("runtime reconstruction failure classification", () => {
  it("terminalizes deterministic identity and policy mismatches immediately", () => {
    expect(terminalRuntimeReconstructionCode(
      new RuntimeSurfaceMismatchError("tool_identity_changed"),
    )).toBe("surface_tool_identity_changed");
    expect(terminalRuntimeReconstructionCode(
      new RuntimeIdentityMismatchError("endpoint_fingerprint_changed"),
    )).toBe("identity_endpoint_fingerprint_changed");
  });

  it("leaves credential and runtime availability failures retryable", () => {
    expect(terminalRuntimeReconstructionCode(
      new Error("credential temporarily unavailable marker-secret-123"),
    )).toBeNull();
  });
});

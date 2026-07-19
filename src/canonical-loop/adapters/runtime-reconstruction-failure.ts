import type { Adapter } from "../adapter-contract.js";

export function createRuntimeReconstructionFailureAdapter(
  retryable = false,
): Adapter {
  return {
    name: "runtime-reconstruction-failed",
    version: "1",
    async runTurn(_input, report) {
      report({
        kind: "error",
        code: retryable ? "runtime_reconstruction_unavailable" : "runtime_reconstruction_failed",
        message: retryable
          ? "The persisted delegated runtime is temporarily unavailable. Autonomous recovery will resume from the durable checkpoint."
          : "The persisted delegated runtime can no longer be reconstructed exactly. Resubmit the operation to retry with the current runtime.",
        retryable,
      });
      return {
        providerState: { adapterName: "runtime-reconstruction-failed", adapterVersion: "1", providerPayload: null },
        terminalReason: "error",
      };
    },
    async abort() {},
  };
}

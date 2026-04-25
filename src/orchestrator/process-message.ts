import type { OrchestratorInput, OrchestratorOutput } from "./types.js";
import { MemoryOrchestrator } from "./orchestrator.js";

export function processMessage(input: OrchestratorInput): OrchestratorOutput {
  return MemoryOrchestrator.getInstance().processMessage(input);
}

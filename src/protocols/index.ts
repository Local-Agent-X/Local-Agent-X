/**
 * Protocol System — central index for all protocol modules.
 */

// Core modules
export { loadCustomProtocols, saveCustomProtocols, createProtocol, editProtocol, deleteProtocol, getProtocol, createBuilderTools } from "./builder.js";
export { fetchRegistry, searchProtocols, installProtocol, createMarketplaceTools } from "./marketplace.js";
export { TEMPLATES, getTemplate, protocolFromTemplate, createTemplateTools } from "./templates.js";
export { createChain, startChain, advanceChain, getChainState, resolveInputs, failChain, createChainTools } from "./chain.js";
export { startExecution, completeStep, failStep, skipStep, pauseExecution, resumeExecution, getProgress, getAllExecutions, createProgressTools } from "./progress.js";
export { createRollbackSession, saveSnapshot, rollbackToStep, rollbackLast, getSnapshots, getSession, createRollbackTools } from "./rollback.js";
export { loadVariables, saveVariables, getVariable, setVariable, deleteVariable, listVariables, interpolateVariables, createVariableTools } from "./variables.js";

// Protocol packs
export { socialProtocols } from "./packs/social.js";
export { developerProtocols } from "./packs/developer.js";
export { smarthomeProtocols } from "./packs/smarthome.js";
export { researchProtocols } from "./packs/research.js";
export { communicationProtocols } from "./packs/communication.js";

// Types
export type { ProtocolTemplate } from "./templates.js";
export type { ChainLink, ProtocolChain, ChainExecutionState } from "./chain.js";
export type { StepStatus, StepProgress, ProtocolProgress } from "./progress.js";
export type { StateSnapshot, RollbackSession } from "./rollback.js";
export type { VariableScope } from "./variables.js";

import type { ToolDefinition } from "../types.js";
import { createBuilderTools } from "./builder.js";
import { createMarketplaceTools } from "./marketplace.js";
import { createTemplateTools } from "./templates.js";
import { createChainTools } from "./chain.js";
import { createProgressTools } from "./progress.js";
import { createRollbackTools } from "./rollback.js";
import { createVariableTools } from "./variables.js";

/** Returns all protocol-system tools from submodules. */
export function createAllProtocolTools(): ToolDefinition[] {
  return [
    ...createBuilderTools(),
    ...createMarketplaceTools(),
    ...createTemplateTools(),
    ...createChainTools(),
    ...createProgressTools(),
    ...createRollbackTools(),
    ...createVariableTools(),
  ];
}

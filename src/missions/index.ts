/**
 * Mission System — central index for all mission modules.
 */

// Core modules
export { loadCustomMissions, saveCustomMissions, createMission, editMission, deleteMission, getMission, createBuilderTools } from "./builder.js";
export { fetchRegistry, searchMissions, installMission, createMarketplaceTools } from "./marketplace.js";
export { TEMPLATES, getTemplate, missionFromTemplate, createTemplateTools } from "./templates.js";
export { loadSchedules, saveSchedules, scheduleMission, unscheduleMission, toggleSchedule, getDueMissions, markMissionRan, getNextCronRun, createSchedulerTools } from "./scheduler.js";
export { createChain, startChain, advanceChain, getChainState, resolveInputs, failChain, createChainTools } from "./chain.js";
export { startExecution, completeStep, failStep, skipStep, pauseExecution, resumeExecution, getProgress, getAllExecutions, createProgressTools } from "./progress.js";
export { createRollbackSession, saveSnapshot, rollbackToStep, rollbackLast, getSnapshots, getSession, createRollbackTools } from "./rollback.js";
export { loadVariables, saveVariables, getVariable, setVariable, deleteVariable, listVariables, interpolateVariables, createVariableTools } from "./variables.js";

// Mission packs
export { socialMissions } from "./packs/social.js";
export { developerMissions } from "./packs/developer.js";
export { smarthomeMissions } from "./packs/smarthome.js";
export { researchMissions } from "./packs/research.js";
export { communicationMissions } from "./packs/communication.js";

// Types
export type { MissionTemplate } from "./templates.js";
export type { ScheduledMission } from "./scheduler.js";
export type { ChainLink, MissionChain, ChainExecutionState } from "./chain.js";
export type { StepStatus, StepProgress, MissionProgress } from "./progress.js";
export type { StateSnapshot, RollbackSession } from "./rollback.js";
export type { VariableScope } from "./variables.js";

import type { ToolDefinition } from "../types.js";
import { createBuilderTools } from "./builder.js";
import { createMarketplaceTools } from "./marketplace.js";
import { createTemplateTools } from "./templates.js";
import { createSchedulerTools } from "./scheduler.js";
import { createChainTools } from "./chain.js";
import { createProgressTools } from "./progress.js";
import { createRollbackTools } from "./rollback.js";
import { createVariableTools } from "./variables.js";

/** Returns all mission-system tools from submodules. */
export function createAllMissionTools(): ToolDefinition[] {
  return [
    ...createBuilderTools(),
    ...createMarketplaceTools(),
    ...createTemplateTools(),
    ...createSchedulerTools(),
    ...createChainTools(),
    ...createProgressTools(),
    ...createRollbackTools(),
    ...createVariableTools(),
  ];
}

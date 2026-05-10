import type { Protocol, ProtocolCondition, ProtocolStep } from "./types.js";

export function evaluateCondition(condition: ProtocolCondition, context: Record<string, unknown>): boolean {
  const fieldValue = context[condition.field];
  switch (condition.operator) {
    case "exists": return fieldValue !== undefined && fieldValue !== null;
    case "not_exists": return fieldValue === undefined || fieldValue === null;
    case "equals": return fieldValue === condition.value;
    case "not_equals": return fieldValue !== condition.value;
    case "contains": return typeof fieldValue === "string" && typeof condition.value === "string" && fieldValue.includes(condition.value);
    case "not_contains": return typeof fieldValue === "string" && typeof condition.value === "string" && !fieldValue.includes(condition.value);
    case "gt": return typeof fieldValue === "number" && typeof condition.value === "number" && fieldValue > condition.value;
    case "lt": return typeof fieldValue === "number" && typeof condition.value === "number" && fieldValue < condition.value;
    default: return true;
  }
}

export function resolveNextStep(step: ProtocolStep, steps: ProtocolStep[], context: Record<string, unknown>): ProtocolStep | null {
  if (step.condition) {
    const result = evaluateCondition(step.condition, context);
    if (!result && step.elseStep) {
      return steps.find(s => s.id === step.elseStep) ?? null;
    }
    if (!result) {
      const idx = steps.indexOf(step);
      return idx + 1 < steps.length ? steps[idx + 1] : null;
    }
  }
  if (step.nextStep) {
    return steps.find(s => s.id === step.nextStep) ?? null;
  }
  const idx = steps.indexOf(step);
  return idx + 1 < steps.length ? steps[idx + 1] : null;
}

export interface DryRunResult {
  missionName: string;
  steps: Array<{
    id: string;
    instruction: string;
    wouldExecuteTools: Array<{ tool: string; args: Record<string, unknown> }>;
    requiresUserAction: boolean;
    hasCondition: boolean;
    conditionSummary?: string;
  }>;
  totalSteps: number;
  userActionSteps: number;
  conditionalSteps: number;
}

export function dryRunProtocol(protocol: Protocol, context: Record<string, unknown> = {}): DryRunResult {
  const drySteps = protocol.steps.map(step => {
    const conditionMet = step.condition ? evaluateCondition(step.condition, context) : true;
    return {
      id: step.id,
      instruction: conditionMet ? step.instruction : `[SKIPPED — condition not met: ${step.condition?.field} ${step.condition?.operator} ${step.condition?.value ?? ""}]`,
      wouldExecuteTools: conditionMet ? (step.suggestedTools ?? []) : [],
      requiresUserAction: conditionMet ? (step.requiresUserAction ?? false) : false,
      hasCondition: !!step.condition,
      conditionSummary: step.condition ? `${step.condition.field} ${step.condition.operator} ${step.condition.value ?? ""}` : undefined,
    };
  });

  return {
    missionName: protocol.name,
    steps: drySteps,
    totalSteps: drySteps.length,
    userActionSteps: drySteps.filter(s => s.requiresUserAction).length,
    conditionalSteps: drySteps.filter(s => s.hasCondition).length,
  };
}

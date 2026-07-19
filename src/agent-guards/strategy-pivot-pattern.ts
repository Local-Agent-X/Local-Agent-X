export type StrategyPivotPattern =
  | "exact-repeat"
  | "mutation-repeat"
  | "no-progress"
  | "redundant-search"
  | "discovery-loop";

export interface ToolResultObservation {
  novel: boolean;
  successfulMutation: boolean;
  pendingPivot: StrategyPivotPattern | null;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
}

export function successfulCommittingCallKey(call: { name: string; arguments: string }): string {
  try {
    return `${call.name}\x00${JSON.stringify(canonicalValue(JSON.parse(call.arguments)))}`;
  } catch {
    return `${call.name}\x00${call.arguments.trim()}`;
  }
}

export function chooseStrategyPivot(facts: {
  exactRepeat: boolean;
  mutationRepeat: boolean;
  noProgress: boolean;
  redundantSearch: boolean;
  discoveryLoop: boolean;
}): StrategyPivotPattern | null {
  if (facts.exactRepeat) return "exact-repeat";
  if (facts.mutationRepeat) return "mutation-repeat";
  if (facts.noProgress) return "no-progress";
  if (facts.redundantSearch) return "redundant-search";
  if (facts.discoveryLoop) return "discovery-loop";
  return null;
}

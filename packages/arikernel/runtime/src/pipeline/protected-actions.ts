import { CAPABILITY_CLASS_MAP } from "@arikernel/core";

// Precompute a lookup: toolClass -> Set of actions covered by at least one
// CapabilityClass. Any matching tool call is "protected" and MUST present a
// valid grant token.
const PROTECTED_ACTIONS = new Map<string, Set<string>>();
for (const mapping of Object.values(CAPABILITY_CLASS_MAP)) {
	let actions = PROTECTED_ACTIONS.get(mapping.toolClass);
	if (!actions) {
		actions = new Set();
		PROTECTED_ACTIONS.set(mapping.toolClass, actions);
	}
	for (const action of mapping.actions) {
		actions.add(action);
	}
}

export function isProtected(toolClass: string, action: string): boolean {
	return PROTECTED_ACTIONS.get(toolClass)?.has(action) ?? false;
}

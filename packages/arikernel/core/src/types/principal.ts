export const TOOL_CLASSES = [
	"http",
	"file",
	"shell",
	"database",
	"browser",
	"retrieval",
	"mcp",
	// Privileged store: vault → page (fill), page → vault (capture),
	// vault → clipboard. Distinct from "browser" because the value
	// must never enter the model context — the policy can deny these
	// independently (e.g. "strict" mode disables auto-paste of secrets
	// even where browser.* is otherwise allowed).
	"secret-vault",
] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

export interface CapabilityConstraints {
	allowedPaths?: string[];
	allowedHosts?: string[];
	allowedCommands?: string[];
	allowedDatabases?: string[];
	maxCallsPerMinute?: number;
}

export interface Capability {
	toolClass: ToolClass;
	actions?: string[];
	constraints?: CapabilityConstraints;
}

export interface Principal {
	id: string;
	name: string;
	capabilities: Capability[];
	/** ID of the parent principal that delegated capabilities to this one. */
	parentId?: string;
}

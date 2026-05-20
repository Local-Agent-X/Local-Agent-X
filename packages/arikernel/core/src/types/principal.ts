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
	// Audit-only class for tool calls that have no agent-controlled I/O sink
	// (LAX-internal orchestration, state transitions, structured workspace
	// docs bounded at higher layers). Routed through Firewall.audit() — never
	// Firewall.execute() — so they land in the hash-chained audit DB and feed
	// behavioral rules WITHOUT triggering taint/capability/SSRF defenses that
	// don't apply. Not a wildcard: callers must classify each tool explicitly.
	"internal",
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

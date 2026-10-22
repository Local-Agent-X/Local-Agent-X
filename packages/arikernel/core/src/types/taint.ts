export const TAINT_SOURCES = [
	"web",
	"rag",
	"email",
	"retrieved-doc",
	"model-generated",
	"user-provided",
	"tool-output",
	"derived-sensitive",
	"content-scan",
	"credential",
] as const;

export type TaintSource = (typeof TAINT_SOURCES)[number];

/**
 * Sources whose content makes a write or a shell command tainted: content the
 * agent did not author (web, retrieved, email) and credential material (a
 * credential file or a stored secret the session read). Every taint-keyed
 * rule and run signal reads this one list; the policy spec's literal lists
 * are pinned to it by a test.
 */
export const TAINTED_CONTENT_SOURCES: readonly TaintSource[] = ["web", "rag", "email", "credential"];

export interface TaintLabel {
	source: TaintSource;
	origin: string;
	confidence: number;
	addedAt: string;
	propagatedFrom?: string;
}

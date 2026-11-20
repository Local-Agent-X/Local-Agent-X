/**
 * What a draft must carry before it enters the learned tier.
 *
 * `draftAdmissionProblem` is the one admission rule, and the one write path
 * (`createLearnedProtocolDraft` in learned-lifecycle.ts) runs it on every
 * draft. A producer cannot skip it by having its own path: an earlier tool-
 * sequence miner did, and drafted 26 "memory_search then memory_search"
 * playbooks on one machine while this rule guarded only the review fork.
 *
 * The write path used to validate only shape (a slug, a one-line description,
 * a non-empty body), so a turn that pushed a repo to master produced
 * `jobs_in_order_crm_master_push`: a playbook for a thing the agent already
 * does natively, named after the one project it happened in. Two rules close
 * that, and both are enforced here in code rather than left to the prompt:
 *
 *  1. Derivability. The proposal names the ONE thing the agent could not have
 *     worked out from its tools and the environment — a hard-won string on an
 *     external system, a pitfall that cost a failed attempt, a correction the
 *     user made, or a precondition nothing documents — and that thing must
 *     actually appear in the body it claims to justify.
 *  2. Class level. The name says what class of work the playbook covers and
 *     which system it drives. A name that carries a workspace project or a
 *     session-artifact word ("audit", "debrief", "walkthrough") only makes
 *     sense for the run that produced it, and is refused.
 *
 * Pure functions; the caller supplies the project names so the rule is
 * deterministic under test.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { workspaceRoot } from "../config.js";
import { hasCapability } from "../tool-registry.js";

export const LEARNED_KNOWLEDGE_KINDS = ["external_string", "pitfall", "user_correction", "precondition"] as const;
export type LearnedKnowledgeKind = (typeof LEARNED_KNOWLEDGE_KINDS)[number];

/** The non-derivable thing a proposal captured. */
export interface LearnedKnowledge {
  kind: LearnedKnowledgeKind;
  /** The exact string, pitfall, correction, or precondition — verbatim from the body. */
  detail: string;
}

const MIN_DETAIL_CHARS = 12;

/** Words that mark a name as one session's artifact rather than a class of work. */
const SESSION_ARTIFACT_TERMS = new Set([
  "audit", "triage", "diagnosis", "debrief", "walkthrough", "forensics", "catchup", "today",
  "session", "fix", "debug", "investigation", "postmortem",
]);

export function isLearnedKnowledgeKind(value: unknown): value is LearnedKnowledgeKind {
  return typeof value === "string" && (LEARNED_KNOWLEDGE_KINDS as readonly string[]).includes(value);
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Kinds that describe an external system. A run whose tool calls never left
 *  the machine cannot have found one, whatever the model claims. */
const EXTERNAL_KINDS: ReadonlySet<LearnedKnowledgeKind> = new Set(["external_string", "precondition"]);

/**
 * Why the proposal is not derivable-proof, or null when it passes. The detail
 * must be quoted from the body: a claim the body does not contain is not
 * knowledge the playbook carries. An external claim needs an egress-class tool
 * in the reviewed run's own evidence.
 */
export function derivabilityProblem(
  learned: LearnedKnowledge | undefined,
  body: string,
  toolSequence: readonly string[],
): string | null {
  if (!learned) {
    return "propose needs `learned`: {kind, detail} naming the one thing the agent could not have derived from its tools and the repo. If there is no such thing, the agent already knows how to do this — do not propose.";
  }
  if (!isLearnedKnowledgeKind(learned.kind)) {
    return `\`learned.kind\` must be one of ${LEARNED_KNOWLEDGE_KINDS.join(", ")}.`;
  }
  const detail = normalizeForMatch(String(learned.detail ?? ""));
  if (detail.length < MIN_DETAIL_CHARS) {
    return "`learned.detail` must quote the specific string, pitfall, correction, or precondition the run captured.";
  }
  if (!normalizeForMatch(body).includes(detail)) {
    return "`learned.detail` must appear verbatim in the body — the playbook has to carry the thing it claims to have learned.";
  }
  if (EXTERNAL_KINDS.has(learned.kind) && !toolSequence.some((tool) => hasCapability(tool, "egress"))) {
    return `\`learned.kind\` "${learned.kind}" describes an external system, but this run never called a tool that reaches one (tools: ${toolSequence.join(", ") || "none"}). Work done only in the local repo with local tools is derivable from the repo — do not propose.`;
  }
  return null;
}

/** Why a draft may enter the learned tier. "reviewed": a post-turn review
 *  proposal, judged by both rules below (`newName` is absent when it refines
 *  an existing learned procedure by its id, whose name was judged when it was
 *  first drafted). "user-catalog": a protocol that was already the user's,
 *  moved into the tier (migrate-agent-protocols.ts); nothing to judge. */
export type DraftAdmission =
  | {
    kind: "reviewed";
    learned: LearnedKnowledge | undefined;
    toolSequence: readonly string[];
    newName?: string;
    projectNames: readonly string[];
  }
  | { kind: "user-catalog" };

/** Why `text` may not be drafted under `admission`, or null when it may. The
 *  write path passes the SKILL.md it is about to store, so the learned detail
 *  is checked against what is actually written. */
export function draftAdmissionProblem(admission: DraftAdmission | undefined, text: string): string | null {
  if (admission?.kind === "user-catalog") return null;
  if (admission?.kind !== "reviewed") {
    return "A learned draft needs an admission: a reviewed proposal that names what it learned, or a protocol that was already the user's.";
  }
  return derivabilityProblem(admission.learned, text, admission.toolSequence)
    ?? (admission.newName === undefined ? null : classLevelNameProblem(admission.newName, admission.projectNames));
}

/** Workspace project names a class-level name may not carry: every directory
 *  directly under the workspace root and under `apps/`. */
export function workspaceProjectNames(root: string = workspaceRoot()): string[] {
  const names = new Set<string>();
  for (const dir of [root, join(root, "apps")]) {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      names.add(entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));
    }
  }
  names.delete("apps");
  return [...names].filter((name) => name.length >= 3);
}

/**
 * Why the name is not class-level, or null when it is. A workspace project
 * name is matched as a whole segment or as a run of segments, so `scanprogress`
 * and `jobs_in_order` are both caught while `jobs` alone is not.
 */
export function classLevelNameProblem(name: string, projectNames: readonly string[]): string | null {
  const segments = name.split("_").filter(Boolean);
  const artifact = segments.find((segment) => SESSION_ARTIFACT_TERMS.has(segment));
  if (artifact) {
    return `"${name}" names one session's ${artifact}, not a class of work. Name the workflow and the system it drives (vercel_custom_domain_link), or do not propose.`;
  }
  const joined = `_${segments.join("_")}_`;
  const project = projectNames.find((candidate) => candidate && joined.includes(`_${candidate}_`));
  if (project) {
    return `"${name}" is named after the workspace project "${project}". A playbook about the user's own repo is derivable from the repo. Name the class of work and the external system instead, or do not propose.`;
  }
  return null;
}

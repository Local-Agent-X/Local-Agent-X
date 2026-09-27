/**
 * Reviewed-procedure drafting — the post-turn review fork's only write path.
 *
 * The fork proposes; it never publishes. A proposal records the proposing
 * session as evidence on a learned candidate (reviewed-procedures.ts) and adds
 * a DRAFT version to the managed learned tier. Only an active version is
 * served to the catalog, and a reviewed draft becomes active only on the
 * user's OK (the chat notice / Settings panel) or on independent evidence
 * (learned-refinement.ts), never on its own.
 */
import { createHash } from "node:crypto";
import crossSessionLearner from "../cognition/cross-session-learning/index.js";
import {
  REVIEWED_PROCEDURE_IDENTITY,
  REVIEWED_PROCEDURE_NAME,
  isReviewedProcedureCandidate,
  isSafeLearnedStringArray,
  readOwnEnumerableData,
  type LearnedCandidate,
} from "../cognition/cross-session-learning/types.js";
import { reviewedProcedureCandidateId } from "../cognition/cross-session-learning/reviewed-procedures.js";
import {
  createLearnedProtocolDraft,
  hasLearnedProtocol,
  loadLearnedProtocol,
  readLearnedProtocolVersion,
  type LearnedProtocolRecord,
  type LearnedProtocolVersion,
} from "./learned-lifecycle.js";

const LEARNED_SLUG = /^learned-[a-f0-9]{20}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const MAX_DESCRIPTION = 300;
const MAX_TRIGGERS = 12;
const MAX_TRIGGER_CHARS = 120;
const MAX_BODY_CHARS = 20_000;

export interface ReviewedProcedureProposal {
  /** Procedure name, or the `learned-…` slug of an existing reviewed procedure. */
  name: string;
  description: string;
  triggers: readonly string[];
  body: string;
  outcome: "verified" | "corrected" | "unverified";
  /** Execution context, never model arguments. */
  sessionId: string;
  toolSequence: readonly string[];
  timestamp?: number;
}

/** What the originating chat shows: Keep activates `versionId`; Discard
 *  rejects the candidate when `canReject`, otherwise only dismisses. */
export interface LearningNotice {
  id: string;
  versionId: string;
  name: string;
  description: string;
  refinement: boolean;
  canReject: boolean;
  expectedActiveVersionId: string | null;
}

export type ProposeReviewedResult =
  | { ok: true; candidateId: string; name: string; created: boolean; drafted: boolean; notice: LearningNotice | null }
  | { ok: false; message: string };

function oneLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
}

function metadataTools(version: LearnedProtocolVersion | undefined): string[] {
  const read = readOwnEnumerableData(version?.metadata, "allowedTools");
  return read.ok && isSafeLearnedStringArray(read.value) ? read.value : [];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function renderReviewedProcedureSkill(input: {
  slug: string; name: string; description: string; triggers: readonly string[];
  allowedTools: readonly string[]; body: string;
}): string {
  return [
    "---",
    `name: ${input.slug}`,
    `description: ${input.description}`,
    ...(input.triggers.length ? ["triggers:", ...input.triggers.map((t) => `  - ${t}`)] : []),
    ...(input.allowedTools.length ? ["allowed-tools:", ...input.allowedTools.map((t) => `  - ${t}`)] : []),
    "tags: [learned, reviewed-procedure]",
    "---",
    "",
    `# ${input.name}`,
    "",
    input.body.trim(),
  ].join("\n") + "\n";
}

function resolveName(requested: string): { name: string } | { error: string } {
  const trimmed = requested.trim();
  if (LEARNED_SLUG.test(trimmed)) {
    crossSessionLearner.refresh();
    const candidate = crossSessionLearner.getCandidates().find((entry) => entry.id === trimmed);
    if (!candidate) return { error: `No learned procedure "${trimmed}".` };
    if (!isReviewedProcedureCandidate(candidate)) {
      return { error: `"${trimmed}" is an observed tool-sequence workflow, not a reviewed procedure. Propose a new procedure under its own name instead.` };
    }
    return { name: candidate.suggestion.name };
  }
  if (!REVIEWED_PROCEDURE_NAME.test(trimmed)) {
    return { error: "`name` must be lowercase letters, digits and underscores (2-48 chars), e.g. thriveventory_purchase_order." };
  }
  return { name: trimmed };
}

export function learningNoticeFor(
  candidate: LearnedCandidate,
  record: LearnedProtocolRecord,
  version: LearnedProtocolVersion,
): LearningNotice | null {
  if (record.state === "active" && record.activeVersionId === version.id) return null;
  return {
    id: candidate.id,
    versionId: version.id,
    name: candidate.suggestion.name,
    description: candidate.suggestion.description,
    refinement: record.state === "active",
    canReject: candidate.state === "candidate" && record.state === "draft",
    expectedActiveVersionId: record.activeVersionId,
  };
}

/**
 * Record a proposal and draft its playbook. Refusals are expected outcomes the
 * fork should read (`ok: false`), not errors.
 */
export function proposeReviewedProcedure(input: ReviewedProcedureProposal): ProposeReviewedResult {
  const resolved = resolveName(input.name);
  if ("error" in resolved) return { ok: false, message: resolved.error };
  const { name } = resolved;
  const description = oneLine(input.description);
  if (!description) return { ok: false, message: "propose needs a one-line `description`." };
  if (description.length > MAX_DESCRIPTION) return { ok: false, message: `Keep \`description\` to one line (under ${MAX_DESCRIPTION} characters).` };
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) return { ok: false, message: "propose needs a markdown `body` — the playbook itself." };
  if (body.length > MAX_BODY_CHARS) return { ok: false, message: `The body is too long (max ${MAX_BODY_CHARS} characters).` };
  const triggers = [...new Set(input.triggers.map((t) => oneLine(String(t)).slice(0, MAX_TRIGGER_CHARS)).filter(Boolean))]
    .slice(0, MAX_TRIGGERS);

  const timestamp = input.timestamp ?? Date.now();
  const recorded = crossSessionLearner.recordReviewedProposal({
    name, description, sessionId: input.sessionId, outcome: input.outcome, timestamp,
  });
  if (!recorded.ok) {
    const why = {
      discarded: `The user discarded "${name}". Do not propose it again.`,
      "no-existing-procedure": "A run the user reverted or corrected cannot start a new procedure. Only add its lesson as a pitfall to an existing learned procedure.",
      "not-reviewed": `"${name}" collides with an observed workflow and cannot be proposed.`,
    } as const;
    return { ok: false, message: why[recorded.reason] };
  }

  const slug = recorded.candidate.id;
  const existing = hasLearnedProtocol(slug) ? loadLearnedProtocol(slug) : null;
  const newest = existing?.versions.at(-1);
  const observed = input.toolSequence.map((tool) => String(tool).trim()).filter((tool) => TOOL_NAME.test(tool));
  const allowedTools = [...new Set([...metadataTools(newest), ...observed])];
  const skillMd = renderReviewedProcedureSkill({ slug, name, description, triggers, allowedTools, body });

  let record: LearnedProtocolRecord;
  let version: LearnedProtocolVersion;
  let drafted = false;
  if (existing && newest && newest.sha256 === sha256(skillMd)) {
    record = existing;
    version = newest;
  } else {
    const draft = createLearnedProtocolDraft({
      slug,
      skillMd,
      metadata: {
        ...REVIEWED_PROCEDURE_IDENTITY,
        candidateId: slug,
        procedureName: name,
        reviewedSessionId: input.sessionId,
        outcome: input.outcome,
        allowedTools,
        toolSequence: allowedTools,
      },
    });
    record = draft.record;
    version = draft.version;
    drafted = true;
  }
  return {
    ok: true,
    candidateId: slug,
    name,
    created: recorded.created,
    drafted,
    notice: learningNoticeFor(recorded.candidate, record, version),
  };
}

/** Notices still waiting on the user for drafts this session proposed last.
 *  The chat snapshot re-delivers these, so a notice sent while nobody was
 *  connected is not lost. */
export function pendingLearningNotices(sessionId: string): LearningNotice[] {
  if (!sessionId) return [];
  crossSessionLearner.refresh();
  const notices: LearningNotice[] = [];
  for (const candidate of crossSessionLearner.getCandidates()) {
    if (!isReviewedProcedureCandidate(candidate) || candidate.state === "rejected") continue;
    if (!(candidate.evidence.proposals ?? []).some((proposal) => proposal.sessionId === sessionId)) continue;
    try {
      if (!hasLearnedProtocol(candidate.id)) continue;
      const record = loadLearnedProtocol(candidate.id);
      const newest = record.versions.at(-1);
      if (!newest || record.state === "archived") continue;
      if (readOwnEnumerableData(newest.metadata, "reviewedSessionId").ok !== true
        || newest.metadata.reviewedSessionId !== sessionId) continue;
      const notice = learningNoticeFor(candidate, record, newest);
      if (notice) notices.push(notice);
    } catch {
      // A malformed or tampered record is never offered for activation.
    }
  }
  return notices;
}

function reviewedCandidateIdFor(nameOrSlug: string): string | null {
  const trimmed = nameOrSlug.trim();
  if (LEARNED_SLUG.test(trimmed)) return trimmed;
  return REVIEWED_PROCEDURE_NAME.test(trimmed) ? reviewedProcedureCandidateId(trimmed) : null;
}

function stateLabel(record: LearnedProtocolRecord): string {
  const newest = record.versions.at(-1);
  if (record.state === "active" && newest && newest.id !== record.activeVersionId) return "active, with a newer draft awaiting the user";
  return record.state === "draft" ? "draft, awaiting the user" : record.state;
}

/**
 * A learned protocol rendered for the review fork to read — the active
 * version when one is live, otherwise the newest draft. Read here rather than
 * through the catalog's get, which opens a learned protocol's capability
 * envelope on the calling op and would confine the review fork itself.
 */
export function describeLearnedProcedure(nameOrSlug: string): string | null {
  const id = reviewedCandidateIdFor(nameOrSlug);
  if (!id) return null;
  crossSessionLearner.refresh();
  const candidate = crossSessionLearner.getCandidates().find((entry) => entry.id === id);
  if (!candidate || !hasLearnedProtocol(id)) return null;
  const record = loadLearnedProtocol(id);
  const version = record.state === "active"
    ? record.versions.find((entry) => entry.id === record.activeVersionId)
    : record.versions.at(-1);
  if (!version) return null;
  const kind = isReviewedProcedureCandidate(candidate) ? "reviewed procedure" : "observed tool-sequence workflow (not refinable)";
  return [
    `# Learned ${kind}: ${candidate.suggestion.name} (${id})`,
    `State: ${stateLabel(record)}.`,
    "",
    readLearnedProtocolVersion(id, version.id),
  ].join("\n");
}

/** Reviewed procedures that are not (fully) live yet, so the fork refines a
 *  pending draft instead of proposing a near-duplicate. The catalog's own
 *  list/search never shows drafts. */
export function pendingProcedureCatalog(query?: string): string {
  const terms = (query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
  crossSessionLearner.refresh();
  const lines: string[] = [];
  for (const candidate of crossSessionLearner.getCandidates()) {
    if (!isReviewedProcedureCandidate(candidate) || candidate.state === "rejected") continue;
    const text = `${candidate.suggestion.name} ${candidate.suggestion.description}`.toLowerCase().replace(/_/g, " ");
    if (terms.length && !terms.some((term) => text.includes(term))) continue;
    let state = candidate.state as string;
    try { if (hasLearnedProtocol(candidate.id)) state = stateLabel(loadLearnedProtocol(candidate.id)); }
    catch { continue; }
    lines.push(`• ${candidate.suggestion.name} (${candidate.id}) — ${candidate.suggestion.description} [${state}]`);
  }
  return lines.length
    ? `\n\nLearned procedures proposed by earlier reviews (refine one with propose using its name):\n${lines.join("\n")}`
    : "";
}

import { createHash } from "node:crypto";
import type { CandidateEvidenceSnapshot, LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import {
  hasCandidateEvidenceIdentity,
  hasEvidenceIdentity,
  isSafeLearnedStringArray,
  readOwnEnumerableData,
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
} from "../cognition/cross-session-learning/types.js";
import {
  createLearnedProtocolDraft, hasLearnedProtocol, loadLearnedProtocol,
  type LearnedProtocolVersion,
} from "./learned-lifecycle.js";

export interface LearnedCandidateDraftMetadata extends Record<string, unknown> {
  evidenceClass: typeof WORKFLOW_TACTIC_IDENTITY.evidenceClass;
  authority: typeof WORKFLOW_TACTIC_IDENTITY.authority;
  candidateId: string;
  evidenceSnapshot: CandidateEvidenceSnapshot;
  confidence: number;
  allowedTools: string[];
  toolSequence: string[];
  evidenceHash: string;
}

export interface LearnedCandidateDraftResult {
  slug: string;
  version: LearnedProtocolVersion;
  created: boolean;
}

interface ValidatedProof {
  id: string;
  state: LearnedCandidate["state"];
  confidence: number;
  evidence: CandidateEvidenceSnapshot;
  tools: string[];
  category: string;
}

function field(value: unknown, key: PropertyKey): unknown {
  const read = readOwnEnumerableData(value, key);
  return read.ok ? read.value : undefined;
}

function canonicalEvidence(proof: ValidatedProof): string {
  return JSON.stringify({
    candidateId: proof.id,
    evidenceSnapshot: proof.evidence,
    confidence: proof.confidence,
    toolSequence: proof.tools,
  });
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function parseToolSequence(sequence: unknown, examples: unknown): string[] {
  if (!isSafeLearnedStringArray(sequence) || sequence.length === 0) {
    throw new Error("Learned workflow candidate has no valid tool sequence");
  }
  if (!isSafeLearnedStringArray(examples) || !sameStrings(sequence, examples)) {
    throw new Error("Learned workflow candidate sequence does not match its evidence");
  }
  const tools: string[] = [];
  for (let index = 0; index < sequence.length; index++) {
    tools.push(...sequence[index].split(" -> ").map((tool) => tool.trim()));
  }
  if (tools.length === 0 || tools.some((tool) => !/^[a-z][a-z0-9_]*$/.test(tool))) {
    throw new Error("Learned workflow candidate contains a malformed tool identity");
  }
  return tools;
}

function validateProof(candidate: LearnedCandidate): ValidatedProof {
  if (!hasCandidateEvidenceIdentity(candidate)) {
    throw new Error("Learned workflow candidate has mismatched evidence authority");
  }
  const id = field(candidate, "id");
  const state = field(candidate, "state");
  const confidence = field(candidate, "confidence");
  const suggestion = field(candidate, "suggestion");
  const evidence = field(candidate, "evidence");
  const config = field(suggestion, "config");
  const patternType = field(evidence, "patternType");
  if (patternType !== "workflow" || field(config, "patternType") !== "workflow") {
    throw new Error("Only workflow candidates can become learned protocol drafts");
  }
  if (
    typeof state !== "string"
    || !["candidate", "approved", "active", "archived"].includes(state)
    || typeof id !== "string"
    || !/^learned-[a-f0-9]{20}$/.test(id)
    || field(suggestion, "type") !== "mission"
    || typeof confidence !== "number"
  ) {
    throw new Error("Malformed learned workflow candidate identity");
  }
  const stats = field(evidence, "outcomeStats");
  const occurrences = field(evidence, "occurrences");
  const description = field(evidence, "description");
  const examples = field(evidence, "examples");
  const lastSeen = field(evidence, "lastSeen");
  if (
    !hasEvidenceIdentity(evidence, TERMINAL_TELEMETRY_IDENTITY)
    || !Number.isInteger(occurrences)
    || (occurrences as number) < 1
    || typeof description !== "string"
    || typeof lastSeen !== "number"
    || !Number.isFinite(lastSeen)
  ) {
    throw new Error("Learned workflow candidate has no outcome proof");
  }
  const clean = field(stats, "clean");
  const partial = field(stats, "partial");
  const aborted = field(stats, "aborted");
  const successRate = field(stats, "successRate");
  const weightedSuccessRate = field(stats, "weightedSuccessRate");
  const distinctSessions = field(stats, "distinctSessions");
  if (
    ![clean, partial, aborted, successRate, weightedSuccessRate, distinctSessions, confidence]
      .every(Number.isFinite)
    || ![clean, partial, aborted, distinctSessions].every(Number.isInteger)
    || typeof clean !== "number" || clean < 0
    || typeof partial !== "number" || partial < 0
    || typeof aborted !== "number" || aborted < 0
    || typeof successRate !== "number"
    || typeof weightedSuccessRate !== "number"
    || typeof distinctSessions !== "number"
    || clean + partial + aborted !== occurrences
    || clean < 3
    || distinctSessions < 2
    || Math.abs(successRate - clean / (clean + partial + aborted)) > 1e-9
    || successRate < 0.75
    || weightedSuccessRate < 0.75
    || weightedSuccessRate > 1
    || confidence < 0.75
    || confidence > 1
    || field(config, "occurrences") !== occurrences
  ) {
    throw new Error("Learned workflow candidate is not outcome-proven");
  }
  const tools = parseToolSequence(field(config, "sequence"), examples);
  const match = description.match(/^Workflow "(browser|computer|coding|connector|research|general):(.+)" completed cleanly (\d+)\/(\d+) times$/);
  if (!match || match[2] !== tools.join(" -> ") || Number(match[3]) !== clean || Number(match[4]) !== occurrences) {
    throw new Error("Learned workflow candidate description does not match its structural evidence");
  }
  const evidenceExamples: string[] = [];
  for (let index = 0; index < (examples as string[]).length; index++) {
    evidenceExamples.push((examples as string[])[index]);
  }
  return {
    id,
    state: state as LearnedCandidate["state"],
    confidence,
    tools,
    category: match[1],
    evidence: {
      ...TERMINAL_TELEMETRY_IDENTITY,
      patternType: "workflow",
      description,
      occurrences: occurrences as number,
      lastSeen,
      examples: evidenceExamples,
      outcomeStats: { clean, partial, aborted, successRate, weightedSuccessRate, distinctSessions },
    },
  };
}

export function learnedProtocolSlug(candidate: LearnedCandidate): string {
  const id = field(candidate, "id");
  if (typeof id !== "string" || !/^learned-[a-f0-9]{20}$/.test(id)) {
    throw new Error("Malformed learned workflow candidate identity");
  }
  return id;
}

export function renderLearnedCandidateSkill(candidate: LearnedCandidate): string {
  return renderValidatedSkill(validateProof(candidate));
}

function renderValidatedSkill(proof: ValidatedProof): string {
  const { tools, category } = proof;
  const slug = proof.id;
  const allowed = [...new Set(tools)];
  const steps = tools.map((tool, index) => `${index + 1}. Use \`${tool}\` for workflow step ${index + 1}.`).join("\n");
  return [
    "---",
    `name: ${slug}`,
    `description: Outcome-proven ${category} workflow using ${tools.join(" then ")}`,
    `when-to-use: ${category} workflow using ${tools.join(" then ")}`,
    "allowed-tools:",
    ...allowed.map((tool) => `  - ${tool}`),
    `category: ${category}`,
    "tags: [learned, workflow]",
    "---",
    "",
    `# Learned workflow ${slug}`,
    "",
    `Run the proven ${tools.join(" -> ")} sequence in this exact order.`,
    "",
    `Observed ${proof.evidence.outcomeStats!.clean} clean outcomes across ${proof.evidence.outcomeStats!.distinctSessions} sessions with confidence ${proof.confidence}.`,
    "",
    "## Ordered tool sequence",
    "",
    steps,
    "",
    "Follow normal tool policy and approval requirements for every step.",
  ].join("\n") + "\n";
}

export function draftLearnedCandidate(candidate: LearnedCandidate): LearnedCandidateDraftResult {
  const proof = validateProof(candidate);
  const { tools } = proof;
  const slug = proof.id;
  if (proof.state === "active" && hasLearnedProtocol(slug)) {
    const managed = loadLearnedProtocol(slug);
    if (!managed.versions.some((version) => field(field(version, "metadata"), "candidateId") === proof.id)) {
      throw new Error("Active learned workflow does not match its managed candidate history");
    }
  }
  const evidenceHash = createHash("sha256").update(canonicalEvidence(proof)).digest("hex");
  const allowedTools = [...new Set(tools)];
  if (hasLearnedProtocol(slug)) {
    const record = loadLearnedProtocol(slug);
    const prior = [...record.versions].reverse().find(
      (version) => field(field(version, "metadata"), "candidateId") === proof.id,
    );
    if (prior) {
      const metadata = field(prior, "metadata");
      const priorEvidence = field(metadata, "evidenceSnapshot");
      const priorTools = field(metadata, "toolSequence");
      const priorHash = field(metadata, "evidenceHash");
      const priorOccurrences = field(priorEvidence, "occurrences");
      const priorConfidence = field(metadata, "confidence");
      if (
        !hasEvidenceIdentity(metadata, WORKFLOW_TACTIC_IDENTITY)
        || !hasEvidenceIdentity(priorEvidence, TERMINAL_TELEMETRY_IDENTITY)
      ) {
        throw new Error("Stored learned workflow draft has mismatched evidence authority");
      }
      if (
        typeof priorHash !== "string"
        || typeof priorOccurrences !== "number"
        || typeof priorConfidence !== "number"
        || !isSafeLearnedStringArray(priorTools)
      ) {
        throw new Error("Stored learned workflow draft has malformed evidence metadata");
      }
      if (!sameStrings(priorTools, tools)) {
        throw new Error("Learned workflow tool sequence changed for an existing candidate");
      }
      if (priorHash === evidenceHash) return { slug, version: prior, created: false };
      if (
        proof.evidence.occurrences < priorOccurrences
        || proof.confidence < priorConfidence
        || (proof.evidence.occurrences === priorOccurrences && proof.confidence === priorConfidence)
      ) {
        throw new Error("Changed evidence does not strengthen the learned workflow candidate");
      }
    }
  }
  const metadata: LearnedCandidateDraftMetadata = {
    ...WORKFLOW_TACTIC_IDENTITY,
    candidateId: proof.id,
    evidenceSnapshot: proof.evidence,
    confidence: proof.confidence,
    allowedTools,
    toolSequence: [...tools],
    evidenceHash,
  };
  const drafted = createLearnedProtocolDraft({ slug, skillMd: renderValidatedSkill(proof), metadata });
  return { slug, version: drafted.version, created: true };
}

import { createHash } from "node:crypto";
import type { CandidateEvidenceSnapshot, LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import {
  createLearnedProtocolDraft, hasLearnedProtocol, loadLearnedProtocol,
  type LearnedProtocolVersion,
} from "./learned-lifecycle.js";

export interface LearnedCandidateDraftMetadata extends Record<string, unknown> {
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

function canonicalEvidence(candidate: LearnedCandidate, tools: string[]): string {
  return JSON.stringify({
    candidateId: candidate.id,
    evidenceSnapshot: candidate.evidence,
    confidence: candidate.confidence,
    toolSequence: tools,
  });
}

function parseToolSequence(candidate: LearnedCandidate): string[] {
  const sequence = candidate.suggestion.config.sequence;
  if (!Array.isArray(sequence) || sequence.length === 0 || !sequence.every((item) => typeof item === "string")) {
    throw new Error("Learned workflow candidate has no valid tool sequence");
  }
  if (JSON.stringify(sequence) !== JSON.stringify(candidate.evidence.examples)) {
    throw new Error("Learned workflow candidate sequence does not match its evidence");
  }
  const tools = sequence.flatMap((item) => item.split(" -> ").map((tool) => tool.trim()));
  if (tools.length === 0 || tools.some((tool) => !/^[a-z][a-z0-9_]*$/.test(tool))) {
    throw new Error("Learned workflow candidate contains a malformed tool identity");
  }
  return tools;
}

function validateProof(candidate: LearnedCandidate): { tools: string[]; category: string } {
  if (candidate.evidence.patternType !== "workflow" || candidate.suggestion.config.patternType !== "workflow") {
    throw new Error("Only workflow candidates can become learned protocol drafts");
  }
  if (candidate.state !== "candidate" || !/^learned-[a-f0-9]{20}$/.test(candidate.id) || candidate.suggestion.type !== "mission") {
    throw new Error("Malformed learned workflow candidate identity");
  }
  const stats = candidate.evidence.outcomeStats;
  if (!stats || !Number.isInteger(candidate.evidence.occurrences) || candidate.evidence.occurrences < 1) {
    throw new Error("Learned workflow candidate has no outcome proof");
  }
  const total = stats.clean + stats.partial + stats.aborted;
  const measuredRate = stats.clean / total;
  if (
    ![stats.clean, stats.partial, stats.aborted, stats.successRate, stats.weightedSuccessRate, stats.distinctSessions, candidate.confidence]
      .every(Number.isFinite)
    || ![stats.clean, stats.partial, stats.aborted, stats.distinctSessions].every(Number.isInteger)
    || stats.clean < 0
    || stats.partial < 0
    || stats.aborted < 0
    || total !== candidate.evidence.occurrences
    || stats.clean < 3
    || stats.distinctSessions < 2
    || Math.abs(stats.successRate - measuredRate) > 1e-9
    || stats.successRate < 0.75
    || stats.weightedSuccessRate < 0.75
    || stats.weightedSuccessRate > 1
    || candidate.confidence < 0.75
    || candidate.confidence > 1
    || candidate.suggestion.config.occurrences !== candidate.evidence.occurrences
  ) {
    throw new Error("Learned workflow candidate is not outcome-proven");
  }
  const tools = parseToolSequence(candidate);
  const match = candidate.evidence.description.match(/^Workflow "(browser|computer|coding|connector|research|general):(.+)" completed cleanly (\d+)\/(\d+) times$/);
  if (!match || match[2] !== tools.join(" -> ") || Number(match[3]) !== stats.clean || Number(match[4]) !== total) {
    throw new Error("Learned workflow candidate description does not match its structural evidence");
  }
  return { tools, category: match[1] };
}

export function learnedProtocolSlug(candidate: LearnedCandidate): string {
  if (!/^learned-[a-f0-9]{20}$/.test(candidate.id)) throw new Error("Malformed learned workflow candidate identity");
  return candidate.id;
}

export function renderLearnedCandidateSkill(candidate: LearnedCandidate): string {
  const { tools, category } = validateProof(candidate);
  const slug = learnedProtocolSlug(candidate);
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
    `Observed ${candidate.evidence.outcomeStats!.clean} clean outcomes across ${candidate.evidence.outcomeStats!.distinctSessions} sessions with confidence ${candidate.confidence}.`,
    "",
    "## Ordered tool sequence",
    "",
    steps,
    "",
    "Follow normal tool policy and approval requirements for every step.",
  ].join("\n") + "\n";
}

export function draftLearnedCandidate(candidate: LearnedCandidate): LearnedCandidateDraftResult {
  const { tools } = validateProof(candidate);
  const slug = learnedProtocolSlug(candidate);
  const evidenceHash = createHash("sha256").update(canonicalEvidence(candidate, tools)).digest("hex");
  const allowedTools = [...new Set(tools)];
  if (hasLearnedProtocol(slug)) {
    const record = loadLearnedProtocol(slug);
    const prior = [...record.versions].reverse().find((version) => version.metadata.candidateId === candidate.id);
    if (prior) {
      const metadata = prior.metadata as unknown as LearnedCandidateDraftMetadata;
      if (metadata.evidenceHash === evidenceHash) return { slug, version: prior, created: false };
      if (JSON.stringify(metadata.toolSequence) !== JSON.stringify(tools)) {
        throw new Error("Learned workflow tool sequence changed for an existing candidate");
      }
      const priorOccurrences = metadata.evidenceSnapshot.occurrences;
      if (
        candidate.evidence.occurrences < priorOccurrences
        || candidate.confidence < metadata.confidence
        || (candidate.evidence.occurrences === priorOccurrences && candidate.confidence === metadata.confidence)
      ) {
        throw new Error("Changed evidence does not strengthen the learned workflow candidate");
      }
    }
  }
  const metadata: LearnedCandidateDraftMetadata = {
    candidateId: candidate.id,
    evidenceSnapshot: structuredClone(candidate.evidence),
    confidence: candidate.confidence,
    allowedTools,
    toolSequence: [...tools],
    evidenceHash,
  };
  const drafted = createLearnedProtocolDraft({ slug, skillMd: renderLearnedCandidateSkill(candidate), metadata });
  return { slug, version: drafted.version, created: true };
}

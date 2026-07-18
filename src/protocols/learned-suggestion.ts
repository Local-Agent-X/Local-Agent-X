import crossSessionLearner from "../cognition/cross-session-learning/index.js";
import type { LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import { getAllProtocols } from "./index.js";
import { loadLearnedProtocol, type LearnedProtocolRecord } from "./learned-lifecycle.js";
import type { Protocol } from "./types.js";

const MIN_SCORE = 6;
const GENERIC_TERMS = new Set([
  "active", "agent", "automatic", "coding", "handle", "learned", "process",
  "protocol", "request", "task", "use", "using", "workflow",
]);
const STOP_TERMS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "by", "can", "do",
  "for", "from", "how", "i", "in", "into", "is", "it", "me", "my", "of",
  "on", "or", "our", "please", "that", "the", "then", "this", "to", "we",
  "what", "when", "with", "you", "your",
]);

export interface LearnedProtocolSuggestion {
  name: string;
  score: number;
  nudge: string;
}

type RecordLoader = (slug: string) => LearnedProtocolRecord;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function distinctiveTerms(value: string): Set<string> {
  return new Set(normalize(value).split(" ").filter((term) =>
    term.length >= 3 && !STOP_TERMS.has(term) && !GENERIC_TERMS.has(term),
  ));
}

function scoreProtocol(message: string, protocol: Protocol): number {
  const messageTerms = distinctiveTerms(message);
  if (messageTerms.size < 2) return 0;

  const fields = [protocol.description, ...protocol.triggers, ...(protocol.tags ?? [])];
  const protocolTerms = new Set(fields.flatMap((field) => [...distinctiveTerms(field)]));
  const overlap = [...protocolTerms].filter((term) => messageTerms.has(term)).length;
  if (overlap < 2) return 0;

  const normalizedMessage = ` ${normalize(message)} `;
  const exactPhrase = fields.some((field) => {
    const phrase = normalize(field);
    return distinctiveTerms(field).size >= 2 && phrase.length > 0 && normalizedMessage.includes(` ${phrase} `);
  });
  return overlap * 2 + 2 + (exactPhrase ? 4 : 0);
}

function verifiedActiveProtocol(
  candidate: LearnedCandidate,
  protocols: Protocol[],
  loadRecord: RecordLoader,
): Protocol | null {
  if (candidate.state !== "active") return null;
  const record = loadRecord(candidate.id);
  if (record.state !== "active" || !record.activeVersionId || record.slug !== candidate.id) return null;
  const activeVersion = record.versions.find((version) => version.id === record.activeVersionId);
  if (!activeVersion || activeVersion.metadata.candidateId !== candidate.id) return null;
  const protocol = protocols.find((entry) => entry.name === record.slug);
  if (!protocol || protocol.source?.type !== "imported") return null;
  return protocol;
}

export function selectLearnedProtocolSuggestion(
  message: string,
  candidates: LearnedCandidate[],
  protocols: Protocol[],
  loadRecord: RecordLoader,
): LearnedProtocolSuggestion | null {
  const ranked: Array<{ protocol: Protocol; score: number }> = [];
  for (const candidate of candidates) {
    try {
      const protocol = verifiedActiveProtocol(candidate, protocols, loadRecord);
      if (!protocol) continue;
      const score = scoreProtocol(message, protocol);
      if (score >= MIN_SCORE) ranked.push({ protocol, score });
    } catch {
      // A missing, malformed, or tampered learned record is never suggested.
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.protocol.name.localeCompare(b.protocol.name));
  const best = ranked[0];
  if (!best) return null;
  const name = best.protocol.name;
  return {
    name,
    score: best.score,
    nudge: `[learned-workflow] "${name}" matches this request. Load it before acting with protocol(action:"get", params:{name:"${name}"}).`,
  };
}

export function getLearnedProtocolSuggestion(message: string): LearnedProtocolSuggestion | null {
  try {
    return selectLearnedProtocolSuggestion(
      message,
      crossSessionLearner.getCandidates(),
      getAllProtocols(),
      loadLearnedProtocol,
    );
  } catch {
    return null;
  }
}

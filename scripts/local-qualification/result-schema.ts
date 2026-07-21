import {
  compareCodePoints, digest, exact, integer, opaqueStringArray, opaqueText, record, safeSum, stringArray, text,
} from "./schema-codec.js";

export const QUALIFICATION_RESULT_SCHEMA = "lax.qualification-result" as const;
export const QUALIFICATION_RESULT_VERSION = 1 as const;
export const QUALIFICATION_SCORECARD_SCHEMA = "lax.qualification-scorecard" as const;
export const QUALIFICATION_SCORECARD_VERSION = 1 as const;

export type QualificationStatus = "pass" | "fail" | "skip" | "timeout";
export type QualificationFailureKind = "product" | "environment";

export interface QualificationEvidenceReference {
  id: string;
  kind: "assertion" | "artifact" | "log" | "metric" | "prerequisite";
  sha256: string;
}

export interface QualificationResult {
  schema: typeof QUALIFICATION_RESULT_SCHEMA;
  version: typeof QUALIFICATION_RESULT_VERSION;
  scenario: { packId: string; packVersion: number; id: string; version: number };
  subject: {
    runtime: { kind: string; version: string; artifactSha256: string };
    model: { coordinateSha256: string; digest: string };
    build: { version: string; commit: string; artifactSha256: string };
  };
  environment: {
    platform: string;
    arch: string;
    prerequisites: Array<{
      id: string;
      version: string;
      status: "available" | "unavailable";
      evidenceRefs: string[];
    }>;
  };
  outcome: {
    status: QualificationStatus;
    durationMs: number;
    retries: number;
    failureClass: { kind: QualificationFailureKind; code: string } | null;
    evidenceRefs: string[];
  };
  evidence: QualificationEvidenceReference[];
  coverageSurface: string[];
  provenance: {
    runnerId: string;
    runnerVersion: string;
    sourceCommit: string;
    completedAt: string;
  };
  resultDigest: string;
}

export interface QualificationPackContract {
  id: string;
  version: number;
  scenarios: Array<{ id: string; version: number }>;
}

export interface QualificationScorecard {
  schema: typeof QUALIFICATION_SCORECARD_SCHEMA;
  version: typeof QUALIFICATION_SCORECARD_VERSION;
  pack: QualificationPackContract;
  compatibilityKey: string;
  verdict: "pass" | "product_failure" | "environment_unavailable" | "incomplete";
  counts: { pass: number; fail: number; skip: number; timeout: number; missing: number };
  failures: { product: number; environment: number };
  durationMs: number;
  retries: number;
  resultDigests: string[];
  coverageSurface: string[];
  scorecardDigest: string;
}

const ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const STATUS = new Set<QualificationStatus>(["pass", "fail", "skip", "timeout"]);
const EVIDENCE_KIND = new Set(["assertion", "artifact", "log", "metric", "prerequisite"]);
const FAILURE_KIND = new Set<QualificationFailureKind>(["product", "environment"]);

function timestamp(value: unknown, label: string): { value: string; milliseconds: number } {
  const parsed = opaqueText(value, label, UTC_TIMESTAMP);
  const milliseconds = Date.parse(parsed);
  const canonical = parsed.includes(".") ? parsed : parsed.replace("Z", ".000Z");
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical) throw new Error(`${label} is invalid`);
  return { value: parsed, milliseconds };
}

function withoutDigest(result: QualificationResult): Omit<QualificationResult, "resultDigest"> {
  const { resultDigest: _, ...unsigned } = result;
  return unsigned;
}

function parseIdentity(value: unknown): QualificationResult["subject"] {
  const subject = record(value, "subject");
  exact(subject, ["runtime", "model", "build"], "subject");
  const runtime = record(subject.runtime, "subject.runtime");
  const model = record(subject.model, "subject.model");
  const build = record(subject.build, "subject.build");
  exact(runtime, ["kind", "version", "artifactSha256"], "subject.runtime");
  exact(model, ["coordinateSha256", "digest"], "subject.model");
  exact(build, ["version", "commit", "artifactSha256"], "subject.build");
  return {
    runtime: {
      kind: text(runtime.kind, "subject.runtime.kind", ID),
      version: text(runtime.version, "subject.runtime.version", /^\S{1,128}$/),
      artifactSha256: opaqueText(runtime.artifactSha256, "subject.runtime.artifactSha256", SHA256),
    },
    model: {
      coordinateSha256: opaqueText(model.coordinateSha256, "subject.model.coordinateSha256", SHA256),
      digest: opaqueText(model.digest, "subject.model.digest", SHA256),
    },
    build: {
      version: text(build.version, "subject.build.version", /^\S{1,128}$/),
      commit: opaqueText(build.commit, "subject.build.commit", COMMIT),
      artifactSha256: opaqueText(build.artifactSha256, "subject.build.artifactSha256", SHA256),
    },
  };
}

function parseEvidence(value: unknown): QualificationEvidenceReference[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("evidence must be a non-empty array");
  const evidence = value.map((item, index) => {
    const row = record(item, `evidence[${index}]`);
    exact(row, ["id", "kind", "sha256"], `evidence[${index}]`);
    const kind = text(row.kind, `evidence[${index}].kind`, ID);
    if (!EVIDENCE_KIND.has(kind)) throw new Error(`evidence[${index}].kind is invalid`);
    return {
      id: text(row.id, `evidence[${index}].id`, ID),
      kind: kind as QualificationEvidenceReference["kind"],
      sha256: opaqueText(row.sha256, `evidence[${index}].sha256`, SHA256),
    };
  }).sort((left, right) => compareCodePoints(left.id, right.id));
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) throw new Error("evidence ids must be unique");
  return evidence;
}

function parseQualificationResultShape(value: unknown, verifyDigest: boolean): QualificationResult {
  const row = record(value, "qualification result");
  exact(row, ["schema", "version", "scenario", "subject", "environment", "outcome", "evidence", "coverageSurface", "provenance", "resultDigest"], "qualification result");
  if (row.schema !== QUALIFICATION_RESULT_SCHEMA || row.version !== QUALIFICATION_RESULT_VERSION) {
    throw new Error("unknown or stale qualification result schema");
  }
  const scenario = record(row.scenario, "scenario");
  exact(scenario, ["packId", "packVersion", "id", "version"], "scenario");
  const environment = record(row.environment, "environment");
  exact(environment, ["platform", "arch", "prerequisites"], "environment");
  if (!Array.isArray(environment.prerequisites)) throw new Error("environment.prerequisites must be an array");
  const prerequisites = environment.prerequisites.map((item, index) => {
    const prerequisite = record(item, `environment.prerequisites[${index}]`);
    exact(prerequisite, ["id", "version", "status", "evidenceRefs"], `environment.prerequisites[${index}]`);
    if (prerequisite.status !== "available" && prerequisite.status !== "unavailable") throw new Error("prerequisite status is invalid");
    return {
      id: text(prerequisite.id, "prerequisite.id", ID),
      version: text(prerequisite.version, "prerequisite.version", /^\S{1,128}$/),
      status: prerequisite.status as "available" | "unavailable",
      evidenceRefs: stringArray(prerequisite.evidenceRefs, "prerequisite.evidenceRefs", ID),
    };
  }).sort((left, right) => compareCodePoints(left.id, right.id));
  if (new Set(prerequisites.map((item) => item.id)).size !== prerequisites.length) throw new Error("prerequisite ids must be unique");
  const outcome = record(row.outcome, "outcome");
  exact(outcome, ["status", "durationMs", "retries", "failureClass", "evidenceRefs"], "outcome");
  if (!STATUS.has(outcome.status as QualificationStatus)) throw new Error("outcome.status is invalid");
  const failure = outcome.failureClass === null ? null : record(outcome.failureClass, "outcome.failureClass");
  if (failure) exact(failure, ["kind", "code"], "outcome.failureClass");
  if (failure && !FAILURE_KIND.has(failure.kind as QualificationFailureKind)) throw new Error("failure kind is invalid");
  if ((outcome.status === "pass") !== (failure === null)) throw new Error("pass must have no failure class and non-pass must have one");
  if (outcome.status === "skip" && failure?.kind !== "environment") throw new Error("skip requires an environmental failure");
  const evidence = parseEvidence(row.evidence);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const evidenceRefs = stringArray(outcome.evidenceRefs, "outcome.evidenceRefs", ID);
  if (evidenceRefs.length === 0 || evidenceRefs.some((id) => !evidenceIds.has(id))) throw new Error("outcome evidence is missing");
  for (const prerequisite of prerequisites) {
    if (prerequisite.evidenceRefs.length === 0 || prerequisite.evidenceRefs.some((id) => !evidenceIds.has(id))) {
      throw new Error("prerequisite evidence is missing");
    }
    if (prerequisite.evidenceRefs.some((id) => evidence.find((item) => item.id === id)?.kind !== "prerequisite")) {
      throw new Error("prerequisite evidence kind is invalid");
    }
  }
  const referencedEvidence = new Set([...evidenceRefs, ...prerequisites.flatMap((item) => item.evidenceRefs)]);
  if (evidence.some((item) => !referencedEvidence.has(item.id))) throw new Error("evidence must be causally referenced");
  if (failure?.kind !== "environment"
    && !evidenceRefs.some((id) => evidence.find((item) => item.id === id)?.kind !== "prerequisite")) {
    throw new Error("pass and product outcomes require causal non-prerequisite evidence");
  }
  if (prerequisites.some((item) => item.status === "unavailable") && failure?.kind !== "environment") {
    throw new Error("unavailable prerequisites require an environmental failure");
  }
  const provenance = record(row.provenance, "provenance");
  exact(provenance, ["runnerId", "runnerVersion", "sourceCommit", "completedAt"], "provenance");
  const completedAt = timestamp(provenance.completedAt, "provenance.completedAt").value;
  const result: QualificationResult = {
    schema: QUALIFICATION_RESULT_SCHEMA,
    version: QUALIFICATION_RESULT_VERSION,
    scenario: {
      packId: text(scenario.packId, "scenario.packId", ID),
      packVersion: integer(scenario.packVersion, "scenario.packVersion", 1),
      id: text(scenario.id, "scenario.id", ID),
      version: integer(scenario.version, "scenario.version", 1),
    },
    subject: parseIdentity(row.subject),
    environment: {
      platform: text(environment.platform, "environment.platform", ID),
      arch: text(environment.arch, "environment.arch", ID),
      prerequisites,
    },
    outcome: {
      status: outcome.status as QualificationStatus,
      durationMs: integer(outcome.durationMs, "outcome.durationMs"),
      retries: integer(outcome.retries, "outcome.retries"),
      failureClass: failure ? {
        kind: failure.kind as QualificationFailureKind,
        code: text(failure.code, "outcome.failureClass.code", ID),
      } : null,
      evidenceRefs,
    },
    evidence,
    coverageSurface: stringArray(row.coverageSurface, "coverageSurface", ID),
    provenance: {
      runnerId: text(provenance.runnerId, "provenance.runnerId", ID),
      runnerVersion: text(provenance.runnerVersion, "provenance.runnerVersion", /^\S{1,128}$/),
      sourceCommit: opaqueText(provenance.sourceCommit, "provenance.sourceCommit", COMMIT),
      completedAt,
    },
    resultDigest: opaqueText(row.resultDigest, "resultDigest", SHA256),
  };
  if (verifyDigest && result.resultDigest !== digest(withoutDigest(result))) throw new Error("qualification result digest mismatch");
  return result;
}

export function parseQualificationResult(value: unknown): QualificationResult {
  return parseQualificationResultShape(value, true);
}

export function sealQualificationResult(value: Omit<QualificationResult, "resultDigest">): QualificationResult {
  const normalized = parseQualificationResultShape({ ...value, resultDigest: `sha256:${"0".repeat(64)}` }, false);
  const unsigned = withoutDigest(normalized);
  return parseQualificationResult({ ...unsigned, resultDigest: digest(unsigned) });
}

function compatibility(result: QualificationResult): string {
  return digest({
    pack: { id: result.scenario.packId, version: result.scenario.packVersion },
    subject: result.subject,
    environment: { platform: result.environment.platform, arch: result.environment.arch },
    runner: { id: result.provenance.runnerId, version: result.provenance.runnerVersion, sourceCommit: result.provenance.sourceCommit },
  });
}

export function aggregateQualificationResults(
  contract: QualificationPackContract,
  values: unknown[],
  options: { asOf?: string; maxAgeMs?: number } = {},
): QualificationScorecard {
  const packId = text(contract.id, "pack.id", ID);
  const packVersion = integer(contract.version, "pack.version", 1);
  const expected = contract.scenarios.map((item, index) => ({
    id: text(item.id, `pack.scenarios[${index}].id`, ID),
    version: integer(item.version, `pack.scenarios[${index}].version`, 1),
  })).sort((left, right) => compareCodePoints(left.id, right.id));
  if (expected.length === 0) throw new Error("invalid pack scenarios");
  if (new Set(expected.map((item) => item.id)).size !== expected.length) throw new Error("duplicate pack scenarios");
  const parsed = values.map(parseQualificationResult);
  if (parsed.some((result) => result.scenario.packId !== packId || result.scenario.packVersion !== packVersion)) throw new Error("mixed or incompatible qualification packs");
  const keys = new Set(parsed.map(compatibility));
  if (keys.size > 1) throw new Error("mixed or incompatible qualification results");
  const prerequisiteIdentity = new Map<string, string>();
  for (const prerequisite of parsed.flatMap((result) => result.environment.prerequisites)) {
    const identity = digest({ version: prerequisite.version, status: prerequisite.status });
    const prior = prerequisiteIdentity.get(prerequisite.id);
    if (prior && prior !== identity) throw new Error("mixed or incompatible environment prerequisites");
    prerequisiteIdentity.set(prerequisite.id, identity);
  }
  if (options.asOf !== undefined || options.maxAgeMs !== undefined) {
    if (!options.asOf || options.maxAgeMs === undefined || !Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 0) {
      throw new Error("staleness check requires deterministic asOf and maxAgeMs");
    }
    let asOf: number;
    try {
      asOf = timestamp(options.asOf, "asOf").milliseconds;
    } catch {
      throw new Error("staleness check requires deterministic asOf and maxAgeMs");
    }
    for (const result of parsed) {
      const completedAt = Date.parse(result.provenance.completedAt);
      if (completedAt > asOf) throw new Error("future-dated qualification result");
      if (asOf - completedAt > options.maxAgeMs) throw new Error("stale qualification result");
    }
  }
  const byScenario = new Map<string, QualificationResult>();
  for (const result of parsed.sort((left, right) => compareCodePoints(left.resultDigest, right.resultDigest))) {
    const wanted = expected.find((item) => item.id === result.scenario.id);
    if (!wanted || wanted.version !== result.scenario.version) throw new Error("unknown or stale scenario version");
    const prior = byScenario.get(result.scenario.id);
    if (prior && prior.resultDigest !== result.resultDigest) throw new Error("conflicting duplicate qualification result");
    byScenario.set(result.scenario.id, result);
  }
  const results = expected.map((item) => byScenario.get(item.id)).filter((item): item is QualificationResult => Boolean(item));
  const counts = { pass: 0, fail: 0, skip: 0, timeout: 0, missing: expected.length - results.length };
  for (const result of results) counts[result.outcome.status] += 1;
  const failures = { product: 0, environment: 0 };
  for (const result of results) {
    if (result.outcome.failureClass) failures[result.outcome.failureClass.kind] += 1;
  }
  const verdict = counts.missing > 0 ? "incomplete"
    : failures.product > 0 ? "product_failure"
      : failures.environment > 0 ? "environment_unavailable"
        : results.every((result) => result.outcome.status === "pass") ? "pass" : "incomplete";
  const durationMs = safeSum(results.map((result) => result.outcome.durationMs), "qualification duration");
  const retries = safeSum(results.map((result) => result.outcome.retries), "qualification retries");
  const unsigned = {
    schema: QUALIFICATION_SCORECARD_SCHEMA,
    version: QUALIFICATION_SCORECARD_VERSION,
    pack: { id: packId, version: packVersion, scenarios: expected },
    compatibilityKey: parsed[0] ? digest({
      base: compatibility(parsed[0]),
      prerequisites: [...prerequisiteIdentity.entries()].sort(([left], [right]) => compareCodePoints(left, right)),
    }) : digest({ pack: packId, version: packVersion, empty: true }),
    verdict,
    counts,
    failures,
    durationMs,
    retries,
    resultDigests: results.map((result) => result.resultDigest).sort(),
    coverageSurface: [...new Set(results.flatMap((result) => result.coverageSurface))].sort(),
  } as const;
  return { ...unsigned, scorecardDigest: digest(unsigned) };
}

export function parseQualificationScorecard(value: unknown): QualificationScorecard {
  const row = record(value, "qualification scorecard");
  exact(row, ["schema", "version", "pack", "compatibilityKey", "verdict", "counts", "failures", "durationMs", "retries", "resultDigests", "coverageSurface", "scorecardDigest"], "qualification scorecard");
  if (row.schema !== QUALIFICATION_SCORECARD_SCHEMA || row.version !== QUALIFICATION_SCORECARD_VERSION) {
    throw new Error("unknown or stale qualification scorecard schema");
  }
  const pack = record(row.pack, "pack");
  exact(pack, ["id", "version", "scenarios"], "pack");
  if (!Array.isArray(pack.scenarios)) throw new Error("pack.scenarios must be an array");
  const scenarios = pack.scenarios.map((item, index) => {
    const scenario = record(item, `pack.scenarios[${index}]`);
    exact(scenario, ["id", "version"], `pack.scenarios[${index}]`);
    return { id: text(scenario.id, "scenario.id", ID), version: integer(scenario.version, "scenario.version", 1) };
  }).sort((left, right) => compareCodePoints(left.id, right.id));
  if (scenarios.length === 0 || new Set(scenarios.map((item) => item.id)).size !== scenarios.length) throw new Error("pack scenarios are invalid");
  const countsRow = record(row.counts, "counts");
  exact(countsRow, ["pass", "fail", "skip", "timeout", "missing"], "counts");
  const counts = {
    pass: integer(countsRow.pass, "counts.pass"),
    fail: integer(countsRow.fail, "counts.fail"),
    skip: integer(countsRow.skip, "counts.skip"),
    timeout: integer(countsRow.timeout, "counts.timeout"),
    missing: integer(countsRow.missing, "counts.missing"),
  };
  const failuresRow = record(row.failures, "failures");
  exact(failuresRow, ["product", "environment"], "failures");
  const failures = {
    product: integer(failuresRow.product, "failures.product"),
    environment: integer(failuresRow.environment, "failures.environment"),
  };
  const verdicts = new Set(["pass", "product_failure", "environment_unavailable", "incomplete"]);
  if (!verdicts.has(row.verdict as string)) throw new Error("scorecard verdict is invalid");
  const resultDigests = opaqueStringArray(row.resultDigests, "resultDigests", SHA256);
  if (resultDigests.some((item) => !SHA256.test(item))) throw new Error("result digest is invalid");
  const statusTotal = safeSum(Object.values(counts), "scorecard counts");
  const failureTotal = safeSum(Object.values(failures), "scorecard failures");
  const nonPassTotal = safeSum([counts.fail, counts.skip, counts.timeout], "scorecard non-pass counts");
  if (statusTotal !== scenarios.length || failureTotal !== nonPassTotal
    || resultDigests.length !== scenarios.length - counts.missing) throw new Error("scorecard counts are inconsistent");
  if (failures.environment < counts.skip || failures.product > counts.fail + counts.timeout) {
    throw new Error("scorecard failure classes are inconsistent with outcome statuses");
  }
  const expectedVerdict = counts.missing > 0 ? "incomplete"
    : failures.product > 0 ? "product_failure"
      : failures.environment > 0 ? "environment_unavailable"
        : "pass";
  if (row.verdict !== expectedVerdict) throw new Error("scorecard verdict is inconsistent");
  const unsigned = {
    schema: QUALIFICATION_SCORECARD_SCHEMA,
    version: QUALIFICATION_SCORECARD_VERSION,
    pack: { id: text(pack.id, "pack.id", ID), version: integer(pack.version, "pack.version", 1), scenarios },
    compatibilityKey: opaqueText(row.compatibilityKey, "compatibilityKey", SHA256),
    verdict: row.verdict as QualificationScorecard["verdict"],
    counts,
    failures,
    durationMs: integer(row.durationMs, "durationMs"),
    retries: integer(row.retries, "retries"),
    resultDigests,
    coverageSurface: stringArray(row.coverageSurface, "coverageSurface", ID),
  };
  const scorecardDigest = opaqueText(row.scorecardDigest, "scorecardDigest", SHA256);
  if (scorecardDigest !== digest(unsigned)) throw new Error("qualification scorecard digest mismatch");
  return { ...unsigned, scorecardDigest };
}

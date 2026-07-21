import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { tsImport } from "tsx/esm/api";
import {
  projectQualificationPackContract,
  qualificationBenchmarkCatalog,
  qualificationSourceCommand,
} from "./benchmark-packs.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
let q2Promise;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function q2() {
  q2Promise ??= tsImport("./result-schema.ts", import.meta.url);
  return q2Promise;
}

export function benchmarkPackForGate(gate) {
  if (!gate?.benchmarkPackId) return undefined;
  const pack = qualificationBenchmarkCatalog.packs.find((item) => item.id === gate.benchmarkPackId);
  if (!pack || pack.gate.id !== gate.id || pack.gate.script !== gate.script || pack.gate.timeoutMs !== gate.timeoutMs) {
    throw new Error(`Release gate ${gate?.id ?? "unknown"} has stale benchmark metadata`);
  }
  if (gate.command !== undefined || gate.args !== undefined || gate.allowPlatformSkip !== undefined) {
    throw new Error(`Release gate ${gate.id} cannot override benchmark execution`);
  }
  return pack;
}

export function validateBenchmarkSourceScript(pack, scripts) {
  const actual = scripts[pack.gate.script];
  if (typeof actual !== "string") return { ok: false, reason: "missing_script" };
  return actual === qualificationSourceCommand(pack)
    ? { ok: true }
    : { ok: false, reason: "stale_benchmark_script" };
}

export function benchmarkReporterArgs(path) {
  return ["--", "--reporter=json", `--outputFile=${path}`];
}

function reporterPath(name, sourceRoot) {
  if (typeof name !== "string") throw new Error("benchmark reporter file name is missing");
  const absolute = resolve(sourceRoot, name);
  const path = relative(resolve(sourceRoot), absolute).split(sep).join("/");
  if (!path || path.startsWith("../") || path.includes(":")) throw new Error("benchmark reporter file is outside the release source");
  return path;
}

function parseReporter(pack, path, sourceRoot) {
  const raw = readFileSync(path, "utf8");
  const report = JSON.parse(raw);
  if (!report || typeof report !== "object" || typeof report.success !== "boolean" || !Array.isArray(report.testResults)) {
    throw new Error("benchmark reporter schema is malformed");
  }
  const expected = new Set(pack.scenarios.map((scenario) => scenario.testPath));
  const files = new Map();
  for (const result of report.testResults) {
    if (!result || typeof result !== "object" || !Array.isArray(result.assertionResults)
      || (result.status !== "passed" && result.status !== "failed")) {
      throw new Error("benchmark reporter result is malformed");
    }
    const pathName = reporterPath(result.name, sourceRoot);
    if (!expected.has(pathName) || files.has(pathName)) throw new Error("benchmark reporter contains an unexpected or duplicate file");
    const assertions = result.assertionResults.map((assertion) => {
      if (!assertion || typeof assertion !== "object" || typeof assertion.fullName !== "string"
        || !["passed", "failed", "pending", "skipped", "todo"].includes(assertion.status)) {
        throw new Error("benchmark reporter assertion is malformed");
      }
      return { status: assertion.status, identitySha256: sha256(assertion.fullName) };
    });
    if (assertions.length === 0) throw new Error("benchmark reporter file has no assertions");
    const identities = assertions.map((assertion) => assertion.identitySha256).sort();
    const scenario = pack.scenarios.find((item) => item.testPath === pathName);
    if (new Set(identities).size !== identities.length) throw new Error("benchmark reporter contains duplicate assertion identities");
    if (identities.length !== scenario.assertionCount || sha256(JSON.stringify(identities)) !== scenario.assertionManifestSha256) {
      throw new Error("benchmark reporter assertion manifest does not match the catalog");
    }
    if (typeof result.startTime !== "number" || typeof result.endTime !== "number"
      || !Number.isFinite(result.startTime) || !Number.isFinite(result.endTime)
      || result.startTime < 0 || result.endTime < result.startTime
      || result.startTime > Number.MAX_SAFE_INTEGER || result.endTime > Number.MAX_SAFE_INTEGER) {
      throw new Error("benchmark reporter timing is invalid");
    }
    const durationMs = Math.round(result.endTime - result.startTime);
    if (!Number.isSafeInteger(durationMs)) throw new Error("benchmark reporter duration is invalid");
    const hasFailure = result.status === "failed" || assertions.some((assertion) => assertion.status === "failed");
    if ((result.status === "failed") !== hasFailure) throw new Error("benchmark reporter status is inconsistent");
    files.set(pathName, {
      status: result.status,
      assertions,
      durationMs,
    });
  }
  const hasFailure = [...files.values()].some((file) => file.status === "failed");
  if (report.success === hasFailure) throw new Error("benchmark reporter success is inconsistent");
  return { raw, files };
}

function skipDisposition(pack, files) {
  const allowed = [];
  const blocked = [];
  for (const scenario of pack.scenarios) {
    const file = files.get(scenario.testPath);
    if (!file) continue;
    const policies = new Map(scenario.allowedSkips.map((skip) => [skip.identitySha256, skip]));
    for (const assertion of file.assertions.filter((item) => ["pending", "skipped", "todo"].includes(item.status))) {
      const policy = policies.get(assertion.identitySha256);
      const compensation = policy && pack.scenarios.find((item) => item.id === policy.compensationScenarioId);
      const compensationFile = compensation && files.get(compensation.testPath);
      const compensated = compensationFile?.status === "passed"
        && compensationFile.assertions.every((item) => item.status === "passed");
      (policy && compensated ? allowed : blocked).push(assertion.identitySha256);
    }
  }
  return { allowed: allowed.sort(), blocked: blocked.sort() };
}

async function scorecard(pack, files, evidence, context) {
  const { sealQualificationResult, aggregateQualificationResults, parseQualificationScorecard } = await q2();
  const contract = projectQualificationPackContract(pack);
  const disposition = skipDisposition(pack, files);
  const results = [];
  for (const scenario of pack.scenarios) {
    const file = files.get(scenario.testPath);
    if (!file) continue;
    const skipped = file.assertions.filter((item) => ["pending", "skipped", "todo"].includes(item.status));
    const blocked = skipped.some((item) => disposition.blocked.includes(item.identitySha256));
    const status = file.status === "failed" ? "fail" : blocked ? "skip" : "pass";
    const kind = status === "skip" ? "environment" : "product";
    const allowedForScenario = skipped.map((item) => item.identitySha256).filter((identity) => disposition.allowed.includes(identity));
    const skipEvidence = allowedForScenario.map((identity, index) => ({
      id: `allowed-skip-${index}`, kind: "assertion", sha256: identity,
    }));
    results.push(sealQualificationResult({
      schema: "lax.qualification-result",
      version: 1,
      scenario: { packId: contract.id, packVersion: contract.version, id: scenario.id, version: scenario.version },
      subject: {
        runtime: { kind: "node", version: context.runtime.node, artifactSha256: sha256(JSON.stringify(context.runtime)) },
        model: { coordinateSha256: sha256("release-benchmark:not-applicable"), digest: sha256("release-benchmark:not-applicable") },
        build: { version: context.packageVersion, commit: context.sourceRevision, artifactSha256: sha256(context.sourceRevision) },
      },
      environment: { platform: context.runtime.platform, arch: context.runtime.arch, prerequisites: [] },
      outcome: {
        status, durationMs: file.durationMs, retries: 0,
        failureClass: status === "pass" ? null : { kind, code: status === "skip" ? "unrecognized-skip" : "test-file-failed" },
        evidenceRefs: ["gate-output", "reporter-file", ...skipEvidence.map((item) => item.id)],
      },
      evidence: [
        { id: "gate-output", kind: "log", sha256: SHA256.test(evidence.outputSha256) ? evidence.outputSha256 : `sha256:${evidence.outputSha256}` },
        { id: "reporter-file", kind: "artifact", sha256: evidence.reporterSha256 },
        ...skipEvidence,
      ],
      coverageSurface: ["qualification", contract.id, scenario.id],
      provenance: { runnerId: "release-gate", runnerVersion: "1", sourceCommit: context.toolingRevision, completedAt: evidence.completedAt },
    }));
  }
  return { scorecard: parseQualificationScorecard(aggregateQualificationResults(contract, results)), disposition, results };
}

export async function buildBenchmarkEvidence(pack, reporterFile, context) {
  let parsed;
  try { parsed = parseReporter(pack, reporterFile, context.sourceRoot); }
  catch (error) {
    const message = String(error?.message ?? error);
    const errorCode = /assertion/.test(message) ? "assertion_manifest_invalid"
      : /timing|duration/.test(message) ? "timing_invalid" : "reporter_invalid";
    const empty = await scorecard(pack, new Map(), {
      outputSha256: context.outputSha256, reporterSha256: sha256("unavailable"), completedAt: context.completedAt,
    }, context);
    return { ...empty, reporterSha256: sha256("unavailable"), reportedFiles: 0, error: errorCode };
  }
  const reporterSha256 = sha256(parsed.raw);
  const built = await scorecard(pack, parsed.files, {
    outputSha256: context.outputSha256, reporterSha256, completedAt: context.completedAt,
  }, context);
  return { ...built, reporterSha256, reportedFiles: parsed.files.size };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function validatePersistedBenchmarkEvidence(gate, evidence, receipt, context) {
  const pack = benchmarkPackForGate(gate);
  if (!pack) return true;
  if (!evidence || typeof evidence !== "object"
    || Object.keys(evidence).sort().join(",") !== "disposition,reportedFiles,reporterSha256,results,scorecard"
    || !SHA256.test(evidence.reporterSha256)
    || evidence.reportedFiles !== pack.scenarios.length
    || !evidence.disposition || !Array.isArray(evidence.disposition.allowed) || !Array.isArray(evidence.disposition.blocked)
    || !Array.isArray(evidence.results) || evidence.results.length !== pack.scenarios.length) return false;
  if (Object.keys(evidence.disposition).sort().join(",") !== "allowed,blocked"
    || evidence.disposition.blocked.length !== 0
    || evidence.disposition.allowed.some((item) => !SHA256.test(item))
    || new Set(evidence.disposition.allowed).size !== evidence.disposition.allowed.length
    || [...evidence.disposition.allowed].sort().some((item, index) => item !== evidence.disposition.allowed[index])) return false;
  const declared = new Set(pack.scenarios.flatMap((scenario) => scenario.allowedSkips.map((skip) => skip.identitySha256)));
  if (evidence.disposition.allowed.some((identity) => !declared.has(identity))) return false;
  try {
    const { aggregateQualificationResults, parseQualificationResult, parseQualificationScorecard } = await q2();
    const parsed = parseQualificationScorecard(evidence.scorecard);
    const contract = projectQualificationPackContract(pack);
    const results = evidence.results.map(parseQualificationResult);
    const rebuilt = aggregateQualificationResults(contract, results);
    if (!same(parsed, rebuilt)) return false;
    const outputSha256 = `sha256:${receipt.outputSha256}`;
    const runtimeSha256 = sha256(JSON.stringify(context.runtime));
    const noModelSha256 = sha256("release-benchmark:not-applicable");
    const scenarios = new Map(pack.scenarios.map((scenario) => [scenario.id, scenario]));
    const allowedFromRows = [];
    for (const result of results) {
      const scenario = scenarios.get(result.scenario.id);
      if (!scenario || result.scenario.packId !== pack.id || result.scenario.packVersion !== pack.version
        || result.scenario.version !== scenario.version || result.outcome.status !== "pass"
        || result.outcome.failureClass !== null || result.outcome.retries !== 0
        || result.provenance.completedAt !== receipt.completedAt || result.provenance.sourceCommit !== context.toolingRevision
        || result.provenance.runnerId !== "release-gate" || result.provenance.runnerVersion !== "1"
        || result.subject.build.commit !== context.sourceRevision || result.subject.build.version !== context.packageVersion
        || result.subject.build.artifactSha256 !== sha256(context.sourceRevision)
        || result.subject.runtime.kind !== "node" || result.subject.runtime.version !== context.runtime.node
        || result.subject.runtime.artifactSha256 !== runtimeSha256
        || result.subject.model.coordinateSha256 !== noModelSha256 || result.subject.model.digest !== noModelSha256
        || result.environment.platform !== context.runtime.platform || result.environment.arch !== context.runtime.arch
        || result.environment.prerequisites.length !== 0
        || !same(result.coverageSurface, ["qualification", pack.id, scenario.id].sort())) return false;
      const evidenceById = new Map(result.evidence.map((item) => [item.id, item]));
      if (evidenceById.get("gate-output")?.sha256 !== outputSha256
        || evidenceById.get("reporter-file")?.sha256 !== evidence.reporterSha256) return false;
      const skipRows = result.evidence.filter((item) => item.id.startsWith("allowed-skip-"));
      const scenarioPolicy = new Set(scenario.allowedSkips.map((skip) => skip.identitySha256));
      if (result.evidence.length !== 2 + skipRows.length
        || result.outcome.evidenceRefs.length !== result.evidence.length
        || skipRows.some((item, index) => item.id !== `allowed-skip-${index}` || item.kind !== "assertion" || !scenarioPolicy.has(item.sha256))) return false;
      for (const item of skipRows) allowedFromRows.push(item.sha256);
    }
    allowedFromRows.sort();
    return parsed.verdict === "pass" && parsed.counts.pass === contract.scenarios.length
      && parsed.pack.id === contract.id && parsed.pack.version === contract.version
      && JSON.stringify(parsed.pack.scenarios) === JSON.stringify([...contract.scenarios].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      && same(allowedFromRows, evidence.disposition.allowed)
      && receipt.testSkips === evidence.disposition.allowed.length
      && evidence.disposition.blocked.length === 0;
  } catch {
    return false;
  }
}

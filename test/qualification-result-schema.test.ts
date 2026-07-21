import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  QUALIFICATION_RESULT_SCHEMA,
  QUALIFICATION_RESULT_VERSION,
  aggregateQualificationResults,
  parseQualificationResult,
  parseQualificationScorecard,
  sealQualificationResult,
  type QualificationPackContract,
  type QualificationResult,
} from "../scripts/local-qualification/result-schema.js";
import { digest } from "../scripts/local-qualification/schema-codec.js";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const commit = "1".repeat(40);
const contract: QualificationPackContract = {
  id: "q3-core",
  version: 2,
  scenarios: [{ id: "channel-restart", version: 3 }, { id: "plugin-activation", version: 1 }],
};

function result(
  id: string,
  status: QualificationResult["outcome"]["status"] = "pass",
  kind: "product" | "environment" = "product",
  overrides: Partial<Omit<QualificationResult, "resultDigest">> = {},
): QualificationResult {
  const unavailable = status !== "pass" && kind === "environment";
  return sealQualificationResult({
    schema: QUALIFICATION_RESULT_SCHEMA,
    version: QUALIFICATION_RESULT_VERSION,
    scenario: { packId: contract.id, packVersion: contract.version, id, version: id === "channel-restart" ? 3 : 1 },
    subject: {
      runtime: { kind: "node", version: "24.1.0", artifactSha256: hash("node") },
      model: { coordinateSha256: hash("fixture-model:1"), digest: hash("model") },
      build: { version: "0.5.3", commit, artifactSha256: hash("build") },
    },
    environment: {
      platform: "win32",
      arch: "x64",
      prerequisites: [{
        id: `${id}-runtime`,
        version: "1",
        status: unavailable ? "unavailable" : "available",
        evidenceRefs: ["prerequisite-check"],
      }],
    },
    outcome: {
      status,
      durationMs: 120,
      retries: 1,
      failureClass: status === "pass" ? null : { kind, code: unavailable ? "loopback-unavailable" : "assertion-failed" },
      evidenceRefs: ["causal-assertion"],
    },
    evidence: [
      { id: "causal-assertion", kind: "assertion", sha256: hash(`${id}-assertion`) },
      { id: "prerequisite-check", kind: "prerequisite", sha256: hash(`${id}-prerequisite`) },
    ],
    coverageSurface: ["channels.inbound", id],
    provenance: { runnerId: "q3-runner", runnerVersion: "1.0.0", sourceCommit: commit, completedAt: "2026-07-20T12:00:00.000Z" },
    ...overrides,
  });
}

describe("canonical qualification result schema", () => {
  it("round-trips a sealed result and scorecard across a restart boundary", () => {
    const values = [result("channel-restart"), result("plugin-activation")];
    const restored = JSON.parse(JSON.stringify(values));
    const scorecard = aggregateQualificationResults(contract, restored);
    const restarted = parseQualificationScorecard(JSON.parse(JSON.stringify(scorecard)));
    expect(restarted.verdict).toBe("pass");
    expect(restarted.counts).toEqual({ pass: 2, fail: 0, skip: 0, timeout: 0, missing: 0 });
    expect(restarted.durationMs).toBe(240);
    expect(restarted.retries).toBe(2);
    expect(restarted.coverageSurface).toEqual(["channel-restart", "channels.inbound", "plugin-activation"]);
  });

  it("deduplicates byte-equivalent results deterministically in any input order", () => {
    const first = result("channel-restart");
    const second = result("plugin-activation");
    const left = aggregateQualificationResults(contract, [first, second, first]);
    const right = aggregateQualificationResults(contract, [second, first]);
    expect(left).toEqual(right);
    expect(left.resultDigests).toHaveLength(2);
  });

  it("rejects conflicting duplicate and mixed-version results", () => {
    const first = result("channel-restart");
    const conflict = result("channel-restart", "fail", "product");
    expect(() => aggregateQualificationResults(contract, [first, conflict])).toThrow(/conflicting duplicate/);
    const mixed = result("plugin-activation", "pass", "product", {
      scenario: { packId: contract.id, packVersion: 3, id: "plugin-activation", version: 1 },
    });
    expect(() => aggregateQualificationResults(contract, [first, mixed])).toThrow(/incompatible qualification packs/);
    expect(() => parseQualificationResult({ ...first, version: 99 })).toThrow(/unknown or stale/);
  });

  it("rejects incompatible exact runtime, model, build, environment, and runner identities", () => {
    const first = result("channel-restart");
    for (const overrides of [
      { subject: { ...first.subject, runtime: { ...first.subject.runtime, artifactSha256: hash("other-runtime") } } },
      { subject: { ...first.subject, model: { ...first.subject.model, coordinateSha256: hash("other-coordinate") } } },
      { subject: { ...first.subject, model: { ...first.subject.model, digest: hash("other-model") } } },
      { subject: { ...first.subject, build: { ...first.subject.build, artifactSha256: hash("other-build") } } },
      { provenance: { ...first.provenance, runnerVersion: "2.0.0" } },
    ]) {
      const changed = result("plugin-activation", "pass", "product", overrides);
      expect(() => aggregateQualificationResults(contract, [first, changed])).toThrow(/incompatible qualification results/);
    }
    const changedEnvironment = result("plugin-activation", "pass", "product", {
      environment: { ...first.environment, platform: "linux" },
    });
    expect(() => aggregateQualificationResults(contract, [first, changedEnvironment])).toThrow(/incompatible qualification results/);
    const changedPrerequisite = result("plugin-activation", "pass", "product", {
      environment: { ...first.environment, prerequisites: [{ ...first.environment.prerequisites[0], version: "2" }] },
    });
    expect(() => aggregateQualificationResults(contract, [first, changedPrerequisite])).toThrow(/incompatible environment prerequisites/);
  });

  it("never converts skip, timeout, missing evidence, or a missing scenario to pass", () => {
    const skipped = aggregateQualificationResults(contract, [
      result("channel-restart", "skip", "environment"), result("plugin-activation"),
    ]);
    expect(skipped.verdict).toBe("environment_unavailable");
    const timeout = aggregateQualificationResults(contract, [
      result("channel-restart", "timeout", "product"), result("plugin-activation"),
    ]);
    expect(timeout.verdict).toBe("product_failure");
    expect(aggregateQualificationResults(contract, [result("channel-restart")]).verdict).toBe("incomplete");
    const missingEvidence = structuredClone(result("channel-restart")) as unknown as Record<string, unknown>;
    (missingEvidence.outcome as Record<string, unknown>).evidenceRefs = [];
    expect(() => parseQualificationResult(missingEvidence)).toThrow(/evidence is missing/);
  });

  it("distinguishes product failure from environmental unavailability", () => {
    const product = aggregateQualificationResults(contract, [
      result("channel-restart", "fail", "product"), result("plugin-activation"),
    ]);
    const environment = aggregateQualificationResults(contract, [
      result("channel-restart", "fail", "environment"), result("plugin-activation"),
    ]);
    expect(product.verdict).toBe("product_failure");
    expect(environment.verdict).toBe("environment_unavailable");
    expect(product.failures).toEqual({ product: 1, environment: 0 });
    expect(environment.failures).toEqual({ product: 0, environment: 1 });
  });

  it("binds failure accounting and exact verdict precedence into restored scorecards", () => {
    const product = result("channel-restart", "fail", "product");
    const environment = result("plugin-activation", "timeout", "environment");
    const scorecard = aggregateQualificationResults(contract, [environment, product]);
    expect(scorecard.verdict).toBe("product_failure");
    expect(scorecard.failures).toEqual({ product: 1, environment: 1 });
    const { scorecardDigest: _, ...unsigned } = scorecard;
    const impossible = { ...unsigned, failures: { product: 0, environment: 0 } };
    expect(() => parseQualificationScorecard({ ...impossible, scorecardDigest: digest(impossible) })).toThrow(/counts are inconsistent/);
    const wrongVerdict = { ...unsigned, verdict: "environment_unavailable" as const };
    expect(() => parseQualificationScorecard({ ...wrongVerdict, scorecardDigest: digest(wrongVerdict) })).toThrow(/verdict is inconsistent/);
    const incomplete = aggregateQualificationResults(contract, [product]);
    expect(incomplete.verdict).toBe("incomplete");
    expect(parseQualificationScorecard(incomplete).verdict).toBe("incomplete");
    const skipped = aggregateQualificationResults(contract, [
      result("channel-restart", "skip", "environment"), result("plugin-activation"),
    ]);
    const { scorecardDigest: __, ...skippedUnsigned } = skipped;
    const productSkip = {
      ...skippedUnsigned,
      failures: { product: 1, environment: 0 },
      verdict: "product_failure" as const,
    };
    expect(() => parseQualificationScorecard({ ...productSkip, scorecardDigest: digest(productSkip) }))
      .toThrow(/failure classes are inconsistent/);
  });

  it("rejects unsafe aggregate duration and retry sums independently", () => {
    const largeDuration = (id: string) => {
      const base = result(id);
      return result(id, "pass", "product", { outcome: { ...base.outcome, durationMs: Number.MAX_SAFE_INTEGER } });
    };
    expect(() => aggregateQualificationResults(contract, [largeDuration("channel-restart"), largeDuration("plugin-activation")]))
      .toThrow(/duration.*safe integer/);
    const largeRetries = (id: string) => {
      const base = result(id);
      return result(id, "pass", "product", { outcome: { ...base.outcome, retries: Number.MAX_SAFE_INTEGER } });
    };
    expect(() => aggregateQualificationResults(contract, [largeRetries("channel-restart"), largeRetries("plugin-activation")]))
      .toThrow(/retries.*safe integer/);
  });

  it("fails closed on stale results with an explicit deterministic clock", () => {
    expect(() => aggregateQualificationResults(contract, [result("channel-restart")], {
      asOf: "2026-07-20T12:05:00.000Z", maxAgeMs: 299_999,
    })).toThrow(/stale qualification result/);
    expect(() => aggregateQualificationResults(contract, [result("channel-restart")], { maxAgeMs: 1 })).toThrow(/deterministic asOf/);
    expect(() => aggregateQualificationResults(contract, [result("channel-restart")], { asOf: "2026-07-20T12:00:00.000Z" })).toThrow(/deterministic asOf/);
    expect(() => aggregateQualificationResults(contract, [result("channel-restart")], {
      asOf: "2026-07-20T11:59:59.999Z", maxAgeMs: 60_000,
    })).toThrow(/future-dated qualification result/);
    expect(() => aggregateQualificationResults(contract, [result("channel-restart")], {
      asOf: "2026-02-30T12:00:00.000Z", maxAgeMs: 60_000,
    })).toThrow(/deterministic asOf/);
  });

  it("normalizes canonical ordering without locale-sensitive comparison", () => {
    const mixedCaseContract: QualificationPackContract = {
      id: "q3-order",
      version: 1,
      scenarios: [{ id: "z-last", version: 1 }, { id: "A-first", version: 1 }],
    };
    const make = (id: string) => result(id, "pass", "product", {
      scenario: { packId: mixedCaseContract.id, packVersion: 1, id, version: 1 },
      coverageSurface: ["z.surface", "A.surface"],
    });
    const left = aggregateQualificationResults(mixedCaseContract, [make("z-last"), make("A-first")]);
    const right = aggregateQualificationResults(mixedCaseContract, [make("A-first"), make("z-last")]);
    expect(left).toEqual(right);
    expect(left.pack.scenarios.map((item) => item.id)).toEqual(["A-first", "z-last"]);
    expect(left.coverageSurface).toEqual(["A.surface", "z.surface"]);
  });

  it("detects result and scorecard tampering", () => {
    const sealed = result("channel-restart");
    expect(() => parseQualificationResult({ ...sealed, coverageSurface: ["tampered"] })).toThrow(/digest mismatch/);
    const scorecard = aggregateQualificationResults(contract, [sealed]);
    expect(() => parseQualificationScorecard({ ...scorecard, durationMs: 0 })).toThrow(/digest mismatch/);
  });

  it("strictly rejects malformed and fuzzed values without throwing non-Errors", () => {
    const malformed: unknown[] = [null, true, 4, "{}", [], {}, { schema: QUALIFICATION_RESULT_SCHEMA },
      { ...result("channel-restart"), prompt: "hidden" }];
    for (let index = 0; index < 100; index += 1) {
      malformed.push({ schema: index % 2 ? QUALIFICATION_RESULT_SCHEMA : String(index), version: index, [`field${index}`]: index });
    }
    for (const value of malformed) {
      try {
        parseQualificationResult(value);
        throw new Error("malformed value was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toBe("malformed value was accepted");
      }
    }
  });

  it("permits only causal references and excludes prompt, tool output, and secrets", () => {
    const sealed = result("channel-restart");
    const encoded = JSON.stringify(sealed);
    expect(encoded).not.toMatch(/prompt|tool.?output|authorization|secret|content|token/i);
    for (const forbidden of ["prompt", "toolOutput", "secret", "content"]) {
      expect(() => parseQualificationResult({ ...sealed, [forbidden]: "sensitive" })).toThrow(/unknown or missing fields/);
    }
    const orphaned = structuredClone(sealed);
    orphaned.evidence.push({ id: "orphan", kind: "log", sha256: hash("orphan") });
    const { resultDigest: _, ...orphanedUnsigned } = orphaned;
    expect(() => sealQualificationResult(orphanedUnsigned)).toThrow(/causally referenced/);
    const wrongKind = structuredClone(sealed);
    wrongKind.evidence.find((item) => item.id === "prerequisite-check")!.kind = "assertion";
    const { resultDigest: __, ...wrongKindUnsigned } = wrongKind;
    expect(() => sealQualificationResult(wrongKindUnsigned)).toThrow(/prerequisite evidence kind/);
    expect(() => parseQualificationResult({
      ...sealed,
      subject: { ...sealed.subject, model: { ...sealed.subject.model, unknown: true } },
    })).toThrow(/unknown or missing fields/);
  });

  it("rejects credential-shaped and unknown high-entropy metadata deterministically", () => {
    const githubPat = "ghp_" + "Ab12".repeat(9);
    const openAiKey = "sk-proj-" + "Ab12".repeat(6);
    const jwt = `eyJ${"Ab".repeat(9)}.eyJ${"Cd".repeat(9)}.${"Ef".repeat(10)}`;
    const highEntropy = "Q7wEr9Ty2Ui4Op6As8Df0Gh1Jk3Lz5Xc7Vb9Nm2Q";
    const base = result("channel-restart", "fail", "product");
    const attempts: Array<() => QualificationResult> = [
      () => result("channel-restart", "fail", "product", { provenance: { ...base.provenance, runnerId: githubPat } }),
      () => result("channel-restart", "fail", "product", { coverageSurface: [openAiKey] }),
      () => result("channel-restart", "fail", "product", { provenance: { ...base.provenance, runnerId: jwt } }),
      () => result("channel-restart", "fail", "product", { subject: { ...base.subject, runtime: { ...base.subject.runtime, version: highEntropy } } }),
      () => result("channel-restart", "fail", "product", { subject: { ...base.subject, build: { ...base.subject.build, version: githubPat } } }),
      () => result("channel-restart", "fail", "product", { environment: { ...base.environment, prerequisites: [{ ...base.environment.prerequisites[0], version: openAiKey }] } }),
      () => result("channel-restart", "fail", "product", { outcome: { ...base.outcome, failureClass: { kind: "product", code: highEntropy } } }),
    ];
    for (const attempt of attempts) expect(attempt).toThrow(/secret-shaped data/);
    expect(() => aggregateQualificationResults({ ...contract, id: githubPat }, [])).toThrow(/secret-shaped data/);
    expect(() => aggregateQualificationResults({ ...contract, scenarios: [{ id: highEntropy, version: 1 }] }, [])).toThrow(/secret-shaped data/);
    expect(() => result("channel-restart")).not.toThrow();
  });

  it("hash-binds arbitrary model coordinates without emitting raw identifiers", () => {
    const models = [
      "Qwen/Qwen2.5-Coder-32B-Instruct-GGUF",
      "bartowski/Qwen2.5-Coder-32B-Instruct-GGUF",
      "mistralai/Mixtral-8x7B-Instruct-v0.1",
      "future-vendor/AnyModel-9000-Custom",
    ];
    const base = result("channel-restart");
    for (const id of models) {
      const sealed = result("channel-restart", "pass", "product", {
        subject: { ...base.subject, model: { ...base.subject.model, coordinateSha256: hash(id) } },
      });
      expect(sealed.subject.model.coordinateSha256).toBe(hash(id));
      expect(JSON.stringify(sealed)).not.toContain(id);
    }
    expect(() => result("channel-restart", "pass", "product", {
      subject: { ...base.subject, model: { ...base.subject.model, coordinateSha256: "sha256:not-a-digest" } },
    })).toThrow(/coordinateSha256 is invalid/);
    const rawCredential = "ghp_" + "Ab12".repeat(9);
    expect(() => sealQualificationResult({
      ...base,
      subject: { ...base.subject, model: { id: rawCredential, digest: base.subject.model.digest } } as never,
    })).toThrow(/unknown or missing fields/);
    const bareEntropy = "Q7wEr9Ty2Ui4Op6As8Df0Gh1Jk3Lz5Xc7Vb9Nm2Q";
    expect(() => result("channel-restart", "pass", "product", { coverageSurface: [bareEntropy] }))
      .toThrow(/secret-shaped data/);
  });

  it("requires non-prerequisite causal evidence for pass and product outcomes", () => {
    const prerequisiteOnly = (id: string, status: "pass" | "timeout", kind: "product" | "environment") => {
      const base = result(id, status === "pass" ? "pass" : "timeout", kind);
      return {
        outcome: { ...base.outcome, evidenceRefs: ["prerequisite-check"] },
        evidence: [{ id: "prerequisite-check", kind: "prerequisite" as const, sha256: hash(`${id}-prerequisite`) }],
      };
    };
    expect(() => result("channel-restart", "pass", "product", prerequisiteOnly("channel-restart", "pass", "product")))
      .toThrow(/non-prerequisite evidence/);
    expect(() => result("channel-restart", "timeout", "product", prerequisiteOnly("channel-restart", "timeout", "product")))
      .toThrow(/non-prerequisite evidence/);
    expect(() => result("channel-restart", "timeout", "environment", prerequisiteOnly("channel-restart", "timeout", "environment")))
      .not.toThrow();
  });
});

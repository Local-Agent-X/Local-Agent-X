import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  QUALIFICATION_BENCHMARK_CATALOG_SCHEMA,
  QUALIFICATION_BENCHMARK_CATALOG_VERSION,
  parseQualificationBenchmarkCatalog,
  projectQualificationPackContract,
  qualificationBenchmarkCatalog,
  qualificationBenchmarkGates,
  qualificationPackContracts,
  qualificationSourceCommand,
} from "../scripts/local-qualification/benchmark-packs.mjs";
import { releaseGates } from "../scripts/release-gates.mjs";
import { benchmarkPackForGate, buildBenchmarkEvidence, validateBenchmarkSourceScript } from "../scripts/local-qualification/release-benchmark-evidence.mjs";

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function cloneCatalog(): Record<string, unknown> {
  return structuredClone(qualificationBenchmarkCatalog) as Record<string, unknown>;
}

function packageScripts(): Record<string, string> {
  return JSON.parse(readFileSync("package.json", "utf8")).scripts;
}

function testPaths(command: string): string[] {
  return command.split(/\s+/).filter((token) => /^(?:test|src)\/.*\.test\.ts$/.test(token));
}

describe("qualification benchmark pack catalog", () => {
  it("is the exact versioned source for the four qualification package scripts", () => {
    expect(qualificationBenchmarkCatalog).toMatchObject({
      schema: QUALIFICATION_BENCHMARK_CATALOG_SCHEMA,
      version: QUALIFICATION_BENCHMARK_CATALOG_VERSION,
    });
    expect(qualificationBenchmarkCatalog.packs.map((pack) => pack.id)).toEqual(["installer", "local-model", "plugins", "channels"]);
    const scripts = packageScripts();
    for (const pack of qualificationBenchmarkCatalog.packs) {
      expect(pack.scenarios.map((scenario) => scenario.testPath)).toEqual(testPaths(scripts[pack.gate.script]));
      expect(qualificationSourceCommand(pack)).toBe(scripts[pack.gate.script]);
      expect(pack.scenarios.every((scenario) => scenario.version === 1)).toBe(true);
    }
  });

  it("projects release gates without changing their order or execution contract", () => {
    expect(qualificationBenchmarkGates).toEqual([
      { id: "installer", script: "test:installer-qualification", timeoutMs: 600_000, benchmarkPackId: "installer" },
      { id: "local-model", script: "test:local-product-qualification", timeoutMs: 2_700_000, benchmarkPackId: "local-model" },
      { id: "plugins", script: "test:plugin-qualification", timeoutMs: 600_000, benchmarkPackId: "plugins" },
      { id: "channels", script: "test:channel-qualification", timeoutMs: 600_000, benchmarkPackId: "channels" },
    ]);
    expect(releaseGates.slice(4, 8)).toEqual(qualificationBenchmarkGates);
    expect(releaseGates.map((gate) => gate.id)).toEqual([
      "environment", "dependency-audit", "build", "full-tests", "installer", "local-model", "plugins", "channels", "attribution",
    ]);
  });

  it("rejects masked, reordered, partial, extra, and operator-mutated source commands", () => {
    const scripts = packageScripts();
    for (const pack of qualificationBenchmarkCatalog.packs) {
      expect(validateBenchmarkSourceScript(pack, scripts)).toEqual({ ok: true });
      const exact = scripts[pack.gate.script];
      const paths = pack.scenarios.map((scenario) => scenario.testPath);
      for (const changed of [
        exact.replace(paths[0], ""),
        exact.replace(`${paths[0]} ${paths[1]}`, `${paths[1]} ${paths[0]}`),
        `${exact} test/extra.test.ts`,
        `${exact} || npm run build`,
        `${exact} | more`,
        `${exact} > report.txt`,
        `node wrapper.mjs ${exact}`,
      ]) {
        expect(validateBenchmarkSourceScript(pack, { ...scripts, [pack.gate.script]: changed })).toEqual({ ok: false, reason: "stale_benchmark_script" });
      }
      expect(validateBenchmarkSourceScript(pack, { ...scripts, [pack.gate.script]: undefined })).toEqual({ ok: false, reason: "missing_script" });
    }
    expect(() => benchmarkPackForGate({ ...qualificationBenchmarkGates[0], command: "node" })).toThrow(/cannot override/);
  });

  it("projects every pack into the Q2 contract without a parallel result implementation", () => {
    expect(qualificationPackContracts).toHaveLength(4);
    for (const [index, pack] of qualificationBenchmarkCatalog.packs.entries()) {
      const contract = projectQualificationPackContract(pack);
      expect(contract).toEqual(qualificationPackContracts[index]);
      expect(contract).toEqual({
        id: pack.id,
        version: pack.version,
        scenarios: pack.scenarios.map(({ id, version }) => ({ id, version })),
      });
    }
  });

  it("fail-closes malformed, duplicate, stale, and cross-pack reuse catalogs", () => {
    const unknown = cloneCatalog();
    unknown.extra = true;
    expect(() => parseQualificationBenchmarkCatalog(unknown)).toThrow(/unknown or missing/);

    const stale = cloneCatalog();
    stale.version = 2;
    expect(() => parseQualificationBenchmarkCatalog(stale)).toThrow(/unknown or stale/);

    const duplicate = cloneCatalog();
    const duplicatePacks = duplicate.packs as Array<Record<string, unknown>>;
    duplicatePacks[1].id = duplicatePacks[0].id;
    expect(() => parseQualificationBenchmarkCatalog(duplicate)).toThrow(/duplicate pack|gate id/);

    const duplicateScenario = cloneCatalog();
    const duplicateScenarioPacks = duplicateScenario.packs as Array<Record<string, unknown>>;
    const installerScenarios = duplicateScenarioPacks[0].scenarios as Array<Record<string, unknown>>;
    const channelScenarios = duplicateScenarioPacks[3].scenarios as Array<Record<string, unknown>>;
    channelScenarios[0].id = installerScenarios[0].id;
    expect(() => parseQualificationBenchmarkCatalog(duplicateScenario)).toThrow(/duplicate scenario/);

    const reused = cloneCatalog();
    const reusedPacks = reused.packs as Array<Record<string, unknown>>;
    const firstScenarios = reusedPacks[0].scenarios as Array<Record<string, unknown>>;
    const secondScenarios = reusedPacks[1].scenarios as Array<Record<string, unknown>>;
    secondScenarios[0].testPath = firstScenarios[0].testPath;
    expect(() => parseQualificationBenchmarkCatalog(reused)).toThrow(/reused/);

    for (const [field, value] of [["timeoutMs", 0], ["timeoutMs", 1.5]] as const) {
      const invalid = cloneCatalog();
      const packs = invalid.packs as Array<Record<string, unknown>>;
      (packs[0].gate as Record<string, unknown>)[field] = value;
      expect(() => parseQualificationBenchmarkCatalog(invalid)).toThrow(/timeoutMs is invalid/);
    }
    const invalidPath = cloneCatalog();
    const invalidPacks = invalidPath.packs as Array<Record<string, unknown>>;
    ((invalidPacks[0].scenarios as Array<Record<string, unknown>>)[0]).testPath = "../outside.test.ts";
    expect(() => parseQualificationBenchmarkCatalog(invalidPath)).toThrow(/testPath is invalid/);

    const invalidVersion = cloneCatalog();
    const versionPacks = invalidVersion.packs as Array<Record<string, unknown>>;
    versionPacks[0].version = 0;
    expect(() => parseQualificationBenchmarkCatalog(invalidVersion)).toThrow(/version is invalid/);

    const empty = cloneCatalog();
    const emptyPacks = empty.packs as Array<Record<string, unknown>>;
    emptyPacks[0].scenarios = [];
    expect(() => parseQualificationBenchmarkCatalog(empty)).toThrow(/scenarios must be non-empty/);
  });

  it("cannot be corrupted by mutation through exported or projected values", () => {
    expect(Object.isFrozen(qualificationBenchmarkCatalog)).toBe(true);
    expect(Object.isFrozen(qualificationBenchmarkCatalog.packs[0].scenarios)).toBe(true);
    expect(() => { (qualificationBenchmarkCatalog.packs[0].gate as { timeoutMs: number }).timeoutMs = 1; }).toThrow();
    expect(() => { (qualificationPackContracts[0].scenarios as Array<unknown>).push({}); }).toThrow();
    expect(qualificationBenchmarkCatalog.packs[0].gate.timeoutMs).toBe(600_000);
  });

  it("allows only an identity-bound skip with a passing compensating scenario", async () => {
    const catalog = cloneCatalog();
    const packs = catalog.packs as Array<Record<string, unknown>>;
    const scenarios = packs[0].scenarios as Array<Record<string, unknown>>;
    const skippedName = "source-owned capability skip";
    for (const scenario of scenarios) {
      const name = scenario.id === "contract" ? skippedName : `${scenario.id} source assertion`;
      scenario.assertionCount = 1;
      scenario.assertionManifestSha256 = sha256(JSON.stringify([sha256(name)]));
    }
    scenarios[0].allowedSkips = [{ identitySha256: sha256(skippedName), compensationScenarioId: "resume" }];
    scenarios[1].platformIndependent = true;
    packs[0].version = 2;
    const pack = parseQualificationBenchmarkCatalog(catalog).packs[0];
    const root = mkdtempSync(join(tmpdir(), "lax-benchmark-policy-"));
    const reporterFile = join(root, "report.json");
    const report = (compensationStatus: "passed" | "skipped") => ({
      success: true,
      testResults: pack.scenarios.map((scenario) => ({
        name: resolve(root, scenario.testPath), status: "passed", startTime: 1, endTime: 2,
        assertionResults: [{
          fullName: scenario.id === "contract" ? skippedName : `${scenario.id} source assertion`,
          status: scenario.id === "contract" ? "skipped" : scenario.id === "resume" ? compensationStatus : "passed",
        }],
      })),
    });
    const context = {
      sourceRoot: root, sourceRevision: "3".repeat(40), toolingRevision: "4".repeat(40), packageVersion: "0.5.3",
      runtime: { platform: "test-platform", arch: "test-arch", node: "v22.test", npm: "10.test" },
      outputSha256: "5".repeat(64), completedAt: "2026-07-21T12:00:00.000Z",
    };
    try {
      writeFileSync(reporterFile, JSON.stringify(report("passed")));
      const allowed = await buildBenchmarkEvidence(pack, reporterFile, context);
      expect(allowed).toMatchObject({ scorecard: { verdict: "pass" }, disposition: { allowed: [sha256(skippedName)], blocked: [] } });
      writeFileSync(reporterFile, JSON.stringify(report("skipped")));
      const blocked = await buildBenchmarkEvidence(pack, reporterFile, context);
      expect(blocked.scorecard.verdict).toBe("environment_unavailable");
      expect(blocked.disposition.blocked).toHaveLength(2);

      const malformed = [
        (value: any) => { value.testResults[0].assertionResults.push(structuredClone(value.testResults[0].assertionResults[0])); },
        (value: any) => { value.testResults[0].assertionResults = []; },
        (value: any) => { value.testResults[0].assertionResults.push({ fullName: "extra assertion", status: "passed" }); },
        (value: any) => { value.testResults[0].startTime = null; },
        (value: any) => { value.testResults[0].endTime = Number.POSITIVE_INFINITY; },
        (value: any) => { value.testResults[0].startTime = 3; value.testResults[0].endTime = 2; },
        (value: any) => { value.testResults[0].endTime = Number.MAX_SAFE_INTEGER + 1; },
      ];
      for (const mutate of malformed) {
        const value = report("passed") as any;
        mutate(value);
        writeFileSync(reporterFile, JSON.stringify(value));
        const rejected = await buildBenchmarkEvidence(pack, reporterFile, context);
        expect(rejected.scorecard.verdict).toBe("incomplete");
        expect(rejected.error).toMatch(/assertion|timing|duration/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { isPidAlive } from "../src/pid-probe.js";
import { releaseGates } from "../scripts/release-gates.mjs";
import { runReleaseGate } from "../scripts/release-gate.mjs";
import { projectQualificationPackContract, qualificationBenchmarkCatalog } from "../scripts/local-qualification/benchmark-packs.mjs";
import { aggregateQualificationResults, sealQualificationResult } from "../scripts/local-qualification/result-schema.js";

const roots: string[] = [];
const child = resolve("test/fixtures/release-gate-child.mjs");
const key = "release-gate-test-key-is-at-least-thirty-two-bytes";
const canonicalInvocation = 'node .release-tools/scripts/release-gate.mjs --source-root "$GITHUB_WORKSPACE" --tooling-revision "$TOOLING_SHA" --report release-gate-report.json';
const runtime = { platform: "test-platform", arch: "test-arch", node: "v22.test", npm: "10.test" };

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function paths() {
  const root = mkdtempSync(join(tmpdir(), "lax-release-gate-"));
  roots.push(root);
  return { reportPath: join(root, "report.json"), statePath: join(root, "state.json") };
}

function benchmarkTempDirectories(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("lax-release-benchmark-")).sort();
}

function gate(id: string, mode: string, extraArgs: string[] = [], allowPlatformSkip = false) {
  return { id, command: process.execPath, args: [child, mode, ...extraArgs], timeoutMs: mode.includes("timeout") ? 500 : 5_000, allowPlatformSkip };
}

function workflow(name: string): string {
  return readFileSync(resolve(".github", "workflows", name), "utf8");
}

function job(value: string, name: string, next?: string): string {
  const start = value.indexOf(`  ${name}:`);
  const end = next ? value.indexOf(`\n  ${next}:`, start) : value.length;
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  return value.slice(start, end < 0 ? value.length : end);
}

function initSource(scripts: Record<string, string> = {}, version: string | null = "0.5.3") {
  const root = mkdtempSync(join(tmpdir(), "lax-release-source-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "release-source", ...(version === null ? {} : { version }), scripts }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "package.json"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Release Gate", "-c", "user.email=gate@example.invalid", "commit", "--quiet", "-m", "source"], { cwd: root });
  return root;
}

let installerAssertions: Map<string, string[]> | undefined;

function installerAssertionNames(): Map<string, string[]> {
  if (installerAssertions) return installerAssertions;
  const pack = qualificationBenchmarkCatalog.packs.find((item) => item.id === "installer")!;
  const output = join(mkdtempSync(join(tmpdir(), "lax-release-list-")), "tests.json");
  roots.push(dirname(output));
  const npmCli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  execFileSync(process.execPath, [npmCli, "exec", "vitest", "list", ...pack.scenarios.map((scenario) => scenario.testPath), "--", `--json=${output}`]);
  installerAssertions = new Map(pack.scenarios.map((scenario) => [scenario.testPath, []]));
  for (const item of JSON.parse(readFileSync(output, "utf8"))) {
    const path = relative(resolve("."), item.file).replaceAll("\\", "/");
    installerAssertions.get(path)?.push(item.name.replaceAll(" > ", " "));
  }
  return installerAssertions;
}

function benchmarkReport(sourceRoot: string, options: { missing?: string; skip?: string; fail?: string } = {}) {
  const pack = qualificationBenchmarkCatalog.packs.find((item) => item.id === "installer")!;
  const names = installerAssertionNames();
  const testResults = pack.scenarios.filter((scenario) => scenario.id !== options.missing).map((scenario) => {
    const status = scenario.id === options.fail ? "failed" : "passed";
    return {
      name: resolve(sourceRoot, scenario.testPath), status, startTime: 1, endTime: 2,
      assertionResults: names.get(scenario.testPath)!.map((fullName, index) => ({
        fullName,
        status: index === 0 && scenario.id === options.skip ? "skipped"
          : index === 0 && scenario.id === options.fail ? "failed" : "passed",
      })),
    };
  });
  return { success: !options.fail, testResults };
}

function benchmarkSpawn(report: unknown, exitCode = 0) {
  return (_command: string, args: string[]) => {
    const output = args.find((arg) => arg.startsWith("--outputFile="));
    if (output) writeFileSync(output.slice("--outputFile=".length), JSON.stringify(report));
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end("bounded benchmark output");
      child.stderr.end();
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

describe("release publication workflows", () => {
  it("gates every versioned publisher and excludes only rolling", () => {
    const publishers = readdirSync(resolve(".github", "workflows"))
      .filter((name) => /\.ya?ml$/.test(name) && workflow(name).includes("softprops/action-gh-release"))
      .sort();
    expect(publishers).toEqual(["build-voice-artifacts.yml", "installer-release.yml", "installer-rolling.yml", "release.yml"]);
    for (const name of ["release.yml", "installer-release.yml", "build-voice-artifacts.yml"]) {
      expect(workflow(name)).toContain(canonicalInvocation);
    }
    const rolling = workflow("installer-rolling.yml");
    expect(rolling).toContain("tag_name: rolling");
    expect(rolling).toMatch(/push:\s+branches:\s+- main/);
    expect(rolling).not.toContain("tags:");
    expect(rolling).not.toContain(canonicalInvocation);
  });

  it("grants write only to artifact-only publisher jobs", () => {
    const source = workflow("release.yml");
    const installer = workflow("installer-release.yml");
    const voice = workflow("build-voice-artifacts.yml");
    for (const value of [source, installer, voice]) {
      const header = value.slice(0, value.indexOf("\njobs:"));
      expect(header).toMatch(/permissions:\s+contents: read/);
      expect(value.match(/contents: write/g)).toHaveLength(1);
    }
    for (const publisher of [
      job(source, "publish"),
      job(installer, "attach-to-release"),
      job(voice, "publish-release"),
    ]) {
      expect(publisher).toMatch(/permissions:\s+contents: write/);
      expect(publisher).not.toContain("actions/checkout");
      expect(publisher).not.toMatch(/^\s+- name:.*\n\s+run:/m);
      const verify = publisher.indexOf("- name: Verify release tag is still immutable");
      const publish = publisher.indexOf("softprops/action-gh-release");
      expect(verify).toBeGreaterThan(publisher.indexOf("actions/download-artifact"));
      expect(publish).toBeGreaterThan(verify);
      const check = publisher.slice(verify, publish);
      expect(check).toContain("actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea");
      expect(check).toContain("EXPECTED_SOURCE_SHA: ${{ needs.release-gate.outputs.source_sha }}");
      expect(check).toContain('while (object.type === "tag")');
      expect(check).toContain("github.rest.git.getTag");
      expect(check).toContain('object.type !== "commit"');
    }
    expect(job(source, "release-gate", "package")).not.toContain("contents: write");
    expect(job(source, "package", "publish")).not.toContain("contents: write");
    expect(job(installer, "release-gate", "build-windows")).not.toContain("contents: write");
    expect(job(source, "package", "publish")).toContain("needs: release-gate");
    expect(job(source, "publish")).toContain("needs: [release-gate, package]");
    expect(job(installer, "build-windows", "build-macos")).toContain("needs: release-gate");
    expect(job(installer, "build-macos", "attach-to-release")).toContain("needs: release-gate");
    expect(job(voice, "build-lite", "build-chatterbox")).toContain("needs: release-gate");
    expect(job(voice, "build-chatterbox", "build-voxcpm")).toContain("needs: release-gate");
    expect(job(voice, "build-voxcpm", "publish-release")).toContain("needs: release-gate");
  });

  it("resolves source and tooling once and propagates immutable SHAs", () => {
    const source = workflow("release.yml");
    const installer = workflow("installer-release.yml");
    const voice = workflow("build-voice-artifacts.yml");
    for (const value of [source, installer, voice]) {
      expect(value).toContain("SOURCE_SHA=$(git rev-parse HEAD)");
      expect(value).toContain("git -C .release-tools rev-parse HEAD");
      expect(value).toContain("persist-credentials: false");
      expect(value).toContain(canonicalInvocation);
    }
    expect(source).toContain("ref: ${{ needs.release-gate.outputs.source_sha }}");
    expect(source).toContain("ref: ${{ needs.release-gate.outputs.tooling_sha }}");
    expect(installer.match(/ref: \$\{\{ needs\.release-gate\.outputs\.source_sha \}\}/g)).toHaveLength(2);
    expect(voice.match(/ref: \$\{\{ needs\.release-gate\.outputs\.source_sha \}\}/g)).toHaveLength(3);
    expect(source).toContain('EVENT_SOURCE_SHA=$(git rev-parse "$EVENT_SHA^{commit}")');
    expect(installer).toContain('EVENT_SOURCE_SHA=$(git rev-parse "$EVENT_SHA^{commit}")');
    for (const value of [source, installer, voice]) {
      expect(value).toContain("/^v[0-9][0-9A-Za-z._-]*$/");
    }
  });
});

describe("release gate evidence", () => {
  it.each(releaseGates.map(({ id }) => id))("blocks publication when %s fails", async (failedId) => {
    const gates = releaseGates.map(({ id }) => gate(id, id === failedId ? "fail" : "pass"));
    const result = await runReleaseGate({ gates, ...paths(), environment: runtime });
    expect(result.status).toBe("blocked");
    expect(result.results.at(-1)).toMatchObject({ id: failedId, status: "failed", exitCode: 9 });
  });

  it("classifies prerequisites, skips, and timeouts without passing", async () => {
    for (const [mode, status] of [["prerequisite", "prerequisite"], ["skip", "failed"]] as const) {
      const result = await runReleaseGate({ gates: [gate("evidence", mode)], ...paths(), environment: runtime });
      expect(result.results[0]).toMatchObject({ status });
    }
    const timed = await runReleaseGate({ gates: [gate("evidence", "timeout")], ...paths(), environment: runtime });
    expect(timed.results[0]).toMatchObject({ status: "timeout", reason: "timeout" });
  });

  it("kills a TERM-resistant descendant after its parent exits and returns within a bound", async () => {
    const p = paths();
    const pidFile = join(resolve(p.reportPath, ".."), "descendant.pid");
    const started = Date.now();
    const result = await runReleaseGate({ gates: [gate("tree", "stubborn-tree-timeout", [pidFile])], ...p, environment: runtime });
    expect(result.results[0]).toMatchObject({ status: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(isPidAlive(pid)).toBe(false);
  });

  it("fails old source explicitly when a required script is absent", async () => {
    const result = await runReleaseGate({
      gates: [{ id: "new-contract", script: "test:new-contract", timeoutMs: 1_000 }],
      sourceRoot: initSource(), ...paths(), environment: runtime,
    });
    expect(result.results[0]).toMatchObject({ status: "prerequisite", reason: "missing_script", exitCode: 2 });
  });

  it("blocks a release source with a missing or invalid package version", async () => {
    for (const version of [null, "latest", "1.2", "1.2.3 || masked"]) {
      await expect(runReleaseGate({
        gates: [gate("one", "pass")], sourceRoot: initSource({}, version), ...paths(), environment: runtime,
      })).rejects.toThrow(/invalid package version/);
    }
  });

  it("requires an authenticated resume key and rejects forged state", async () => {
    const p = paths();
    const gates = [gate("one", "pass"), gate("two", "fail")];
    await runReleaseGate({ gates, ...p, key, environment: runtime });
    await expect(runReleaseGate({ gates, ...p, resume: true, environment: runtime })).rejects.toThrow(/requires LAX_RELEASE/);
    const state = JSON.parse(readFileSync(p.statePath, "utf8"));
    state.evidence[0].outputBytes += 1;
    writeFileSync(p.statePath, JSON.stringify(state));
    await expect(runReleaseGate({ gates, ...p, key, resume: true, environment: runtime })).rejects.toThrow(/forged/);
  });

  it("rejects receipts across source revisions and environments", async () => {
    const sourceRoot = initSource();
    const p = paths();
    const gates = [gate("one", "pass"), gate("two", "fail")];
    await runReleaseGate({ gates, sourceRoot, ...p, key, environment: runtime });
    await expect(runReleaseGate({ gates, sourceRoot, ...p, key, resume: true, environment: { ...runtime, arch: "other" } })).rejects.toThrow(/stale/);
    writeFileSync(join(sourceRoot, "revision.txt"), "next\n");
    execFileSync("git", ["add", "revision.txt"], { cwd: sourceRoot });
    execFileSync("git", ["-c", "user.name=Release Gate", "-c", "user.email=gate@example.invalid", "commit", "--quiet", "-m", "next"], { cwd: sourceRoot });
    await expect(runReleaseGate({ gates, sourceRoot, ...p, key, resume: true, environment: runtime })).rejects.toThrow(/stale/);
  });

  it("binds and verifies immutable tooling revision and runner digest", async () => {
    const result = await runReleaseGate({ gates: [gate("one", "pass")], ...paths(), environment: runtime });
    expect(result.toolingRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(result.runnerDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(runReleaseGate({
      gates: [gate("one", "pass")], ...paths(), environment: runtime, expectedToolingRevision: "0".repeat(40),
    })).rejects.toThrow(/tooling revision mismatch/);
  });

  it("emits a real Q2 scorecard from benchmark reporter evidence and resumes it", async () => {
    const pack = qualificationBenchmarkCatalog.packs.find((item) => item.id === "installer")!;
    const sourceRoot = initSource({ [pack.gate.script]: "vitest run test/installer-contract.test.ts test/installer-resume.test.ts test/installer-rollback.test.ts" });
    const p = paths();
    const gateDefinition = releaseGates.find((item) => item.id === "installer")!;
    const result = await runReleaseGate({
      gates: [gateDefinition], sourceRoot, ...p, key, environment: runtime,
      spawnRunner: benchmarkSpawn(benchmarkReport(sourceRoot)),
    });
    expect(result.status).toBe("passed");
    expect(result.results[0].benchmarkEvidence).toMatchObject({
      reportedFiles: 3, disposition: { allowed: [], blocked: [] },
      scorecard: { verdict: "pass", counts: { pass: 3, missing: 0 } },
    });
    expect(result.results[0].benchmarkEvidence.results).toHaveLength(3);
    const resumed = await runReleaseGate({ gates: [gateDefinition], sourceRoot, ...p, key, resume: true, environment: runtime });
    expect(resumed.results[0]).toMatchObject({
      status: "resumed", receipt: { benchmarkEvidence: { scorecard: { verdict: "pass" } } },
    });
  });

  it("rejects stale benchmark commands before spawning a tagged source script", async () => {
    const pack = qualificationBenchmarkCatalog.packs.find((item) => item.id === "installer")!;
    const exact = "vitest run test/installer-contract.test.ts test/installer-resume.test.ts test/installer-rollback.test.ts";
    const gateDefinition = releaseGates.find((item) => item.id === "installer")!;
    let spawns = 0;
    for (const changed of [
      undefined,
      exact.replace("test/installer-contract.test.ts ", ""),
      "vitest run test/installer-resume.test.ts test/installer-contract.test.ts test/installer-rollback.test.ts",
      `${exact} test/extra.test.ts`,
      `${exact} || npm run build`,
    ]) {
      const sourceRoot = initSource(changed === undefined ? {} : { [pack.gate.script]: changed });
      const result = await runReleaseGate({
        gates: [gateDefinition], sourceRoot, ...paths(), environment: runtime,
        spawnRunner: () => { spawns += 1; throw new Error("must not spawn"); },
      });
      expect(result.results[0]).toMatchObject({
        status: "prerequisite", reason: changed === undefined ? "missing_script" : "stale_benchmark_script",
      });
    }
    expect(spawns).toBe(0);
  });

  it("blocks partial, malformed, skipped, and output-mismatched benchmark evidence", async () => {
    const pack = qualificationBenchmarkCatalog.packs.find((item) => item.id === "installer")!;
    const script = "vitest run test/installer-contract.test.ts test/installer-resume.test.ts test/installer-rollback.test.ts";
    const gateDefinition = releaseGates.find((item) => item.id === "installer")!;
    for (const [reportFactory, reason, verdict] of [
      [(root: string) => benchmarkReport(root, { missing: "rollback" }), "incomplete_benchmark_evidence", "incomplete"],
      [() => ({ success: true, testResults: "not-an-array" }), "malformed_benchmark_evidence", "incomplete"],
      [(root: string) => benchmarkReport(root, { skip: "contract" }), "unrecognized_benchmark_skip", "environment_unavailable"],
      [(root: string) => benchmarkReport(root, { fail: "resume" }), "incomplete_benchmark_evidence", "product_failure"],
    ] as const) {
      const sourceRoot = initSource({ [pack.gate.script]: script });
      const result = await runReleaseGate({
        gates: [gateDefinition], sourceRoot, ...paths(), environment: runtime,
        spawnRunner: benchmarkSpawn(reportFactory(sourceRoot)),
      });
      expect(result.status).toBe("blocked");
      expect(result.results[0]).toMatchObject({ status: "failed", reason, benchmarkEvidence: { scorecard: { verdict } } });
    }
    const sourceRoot = initSource({ [pack.gate.script]: script });
    const failedProcess = await runReleaseGate({
      gates: [gateDefinition], sourceRoot, ...paths(), environment: runtime,
      spawnRunner: benchmarkSpawn(benchmarkReport(sourceRoot), 9),
    });
    expect(failedProcess.results[0]).toMatchObject({ status: "failed", reason: "exit_9", benchmarkEvidence: { scorecard: { verdict: "pass" } } });
  });

  it("contains Q2 transformation failure and cleans reporter temp state", async () => {
    const pack = qualificationBenchmarkCatalog.packs.find((item) => item.id === "installer")!;
    const sourceRoot = initSource({ [pack.gate.script]: "vitest run test/installer-contract.test.ts test/installer-resume.test.ts test/installer-rollback.test.ts" });
    const gateDefinition = releaseGates.find((item) => item.id === "installer")!;
    const before = benchmarkTempDirectories();
    const result = await runReleaseGate({
      gates: [gateDefinition], sourceRoot, ...paths(),
      environment: { ...runtime, node: `ghp_${"x".repeat(36)}` },
      spawnRunner: benchmarkSpawn(benchmarkReport(sourceRoot)),
    });
    expect(result).toMatchObject({
      status: "blocked",
      results: [{ status: "failed", reason: "malformed_benchmark_evidence", benchmarkEvidence: { scorecard: { verdict: "incomplete" } } }],
    });
    expect(benchmarkTempDirectories()).toEqual(before);

    await expect(runReleaseGate({
      gates: [gateDefinition], sourceRoot, ...paths(), environment: runtime,
      spawnRunner: () => { throw new Error("spawn failed"); },
    })).rejects.toThrow(/spawn failed/);
    expect(benchmarkTempDirectories()).toEqual(before);
  });

  it("rejects MAC-valid but forged resumed benchmark scorecards and receipts", async () => {
    const pack = qualificationBenchmarkCatalog.packs.find((item) => item.id === "installer")!;
    const sourceRoot = initSource({ [pack.gate.script]: "vitest run test/installer-contract.test.ts test/installer-resume.test.ts test/installer-rollback.test.ts" });
    const p = paths();
    const gateDefinition = releaseGates.find((item) => item.id === "installer")!;
    await runReleaseGate({
      gates: [gateDefinition], sourceRoot, ...p, key, environment: runtime,
      spawnRunner: benchmarkSpawn(benchmarkReport(sourceRoot)),
    });
    const original = JSON.parse(readFileSync(p.statePath, "utf8"));
    const semanticForgery = (state: any) => {
      const evidence = state.evidence[0].benchmarkEvidence;
      evidence.results = evidence.results.map((row: any) => {
        const { resultDigest: _digest, ...unsigned } = row;
        unsigned.subject.runtime.version = "v99.0.0";
        return sealQualificationResult(unsigned);
      });
      evidence.scorecard = aggregateQualificationResults(projectQualificationPackContract(pack), evidence.results);
    };
    for (const mutate of [
      (state: any) => { state.evidence[0].benchmarkEvidence.scorecard.verdict = "product_failure"; },
      (state: any) => { state.evidence[0].unexpected = true; },
      (state: any) => { state.evidence[0].benchmarkEvidence.disposition.allowed = [`sha256:${"a".repeat(64)}`]; },
      (state: any) => { state.evidence[0].testSkips = 1; },
      semanticForgery,
    ]) {
      const state = structuredClone(original);
      mutate(state);
      const { mac: _mac, ...payload } = state;
      state.mac = createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
      writeFileSync(p.statePath, JSON.stringify(state));
      await expect(runReleaseGate({ gates: [gateDefinition], sourceRoot, ...p, key, resume: true, environment: runtime }))
        .rejects.toThrow(/stale, forged, or invalid/);
    }
  });
});

#!/usr/bin/env node
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { terminateProcessTree } from "./release-process-tree.mjs";
import { RELEASE_GATE_SCHEMA, releaseGates } from "./release-gates.mjs";
import {
  benchmarkPackForGate,
  benchmarkReporterArgs,
  buildBenchmarkEvidence,
  validateBenchmarkSourceScript,
  validatePersistedBenchmarkEvidence,
} from "./local-qualification/release-benchmark-evidence.mjs";

const toolingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32"
  ? [resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];

function parseArgs(args) {
  const options = { sourceRoot: toolingRoot, report: undefined, state: undefined, resume: false, toolingRevision: undefined };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--resume") options.resume = true;
    else if (args[index] === "--source-root" && args[index + 1]) options.sourceRoot = resolve(args[++index]);
    else if (args[index] === "--report" && args[index + 1]) options.report = resolve(args[++index]);
    else if (args[index] === "--state" && args[index + 1]) options.state = resolve(args[++index]);
    else if (args[index] === "--tooling-revision" && args[index + 1]) options.toolingRevision = args[++index].toLowerCase();
    else throw new Error(`Unknown release gate argument: ${args[index]}`);
  }
  return options;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitRevision(root, label) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !/^[a-f0-9]{40,64}$/i.test(result.stdout.trim())) {
    throw new Error(`${label} is not a Git revision: ${root}`);
  }
  return result.stdout.trim().toLowerCase();
}

function runnerDigest() {
  const hash = createHash("sha256");
  for (const path of [
    fileURLToPath(import.meta.url), resolve(toolingRoot, "scripts", "release-gates.mjs"),
    resolve(toolingRoot, "scripts", "release-process-tree.mjs"),
    resolve(toolingRoot, "scripts", "local-qualification", "benchmark-packs.mjs"),
    resolve(toolingRoot, "scripts", "local-qualification", "release-benchmark-evidence.mjs"),
    resolve(toolingRoot, "scripts", "local-qualification", "result-schema.ts"),
    resolve(toolingRoot, "scripts", "local-qualification", "schema-codec.ts"),
  ]) {
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

function executionEnvironment(override) {
  if (override) return override;
  const npmVersion = spawnSync(npmCommand, [...npmPrefix, "--version"], { encoding: "utf8", windowsHide: true });
  if (npmVersion.status !== 0) throw new Error("Release environment has no working npm executable");
  return { platform: platform(), arch: arch(), node: process.version, npm: npmVersion.stdout.trim() };
}

function readSourcePackage(sourceRoot) {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
    if (typeof packageJson?.version !== "string" || packageJson.version.length > 128
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(packageJson.version)) {
      throw new Error(`Release source has an invalid package version: ${sourceRoot}`);
    }
    return {
      version: packageJson.version,
      scripts: packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {},
    };
  } catch (error) {
    if (String(error?.message ?? error).includes("invalid package version")) throw error;
    throw new Error(`Release source has no readable package.json: ${sourceRoot}`);
  }
}

function validateGates(gates) {
  const ids = gates.map((gate) => gate?.id);
  if (!ids.length || ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) {
    throw new Error("Release gate definitions must have unique string IDs");
  }
}

function resumeKey(value) {
  if (value === undefined) return undefined;
  const key = Buffer.from(value, "utf8");
  if (key.length < 32) throw new Error("Release gate resume key must be at least 32 bytes");
  return key;
}

function signedState(value, key) {
  const payload = JSON.stringify(value);
  return { ...value, mac: createHmac("sha256", key).update(payload).digest("hex") };
}

function verifyStateMac(state, key) {
  if (typeof state?.mac !== "string" || !/^[a-f0-9]{64}$/.test(state.mac)) return false;
  const { mac, ...payload } = state;
  const expected = createHmac("sha256", key).update(JSON.stringify(payload)).digest();
  return timingSafeEqual(Buffer.from(mac, "hex"), expected);
}

async function readState(path, expectedFingerprint, gates, key, context) {
  let state;
  try { state = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return { schema: RELEASE_GATE_SCHEMA, fingerprint: expectedFingerprint, evidence: [] };
    throw new Error(`Release gate state is unreadable: ${path}`);
  }
  const known = new Map(gates.map((gate) => [gate.id, gate]));
  const evidence = state?.evidence;
  const validEvidence = Array.isArray(evidence)
    && new Set(evidence.map((item) => item?.id)).size === evidence.length
    && evidence.every((item) => {
      const gate = known.get(item?.id);
      const expectedFields = ["id", "status", "exitCode", "outputBytes", "outputSha256", "testSkips", "completedAt", ...(gate?.benchmarkPackId ? ["benchmarkEvidence"] : [])].sort();
      if (!item || typeof item !== "object" || Object.keys(item).sort().some((field, index) => field !== expectedFields[index])
        || Object.keys(item).length !== expectedFields.length) return false;
      const validOutcome = (item?.status === "passed" && item?.exitCode === 0)
        || (item?.status === "platform_skip" && item?.exitCode === 77 && gate?.allowPlatformSkip === true);
      return validOutcome && Number.isInteger(item?.outputBytes) && item.outputBytes >= 0
        && Number.isInteger(item?.testSkips) && item.testSkips >= 0
        && /^[a-f0-9]{64}$/.test(item?.outputSha256) && typeof item?.completedAt === "string";
    });
  if (!verifyStateMac(state, key) || state?.schema !== RELEASE_GATE_SCHEMA
      || state?.fingerprint !== expectedFingerprint || !validEvidence) {
    throw new Error(`Release gate state has a stale, forged, or invalid schema: ${path}`);
  }
  for (const item of evidence) {
    const gate = known.get(item.id);
    if (!await validatePersistedBenchmarkEvidence(gate, item.benchmarkEvidence, item, context)) {
      throw new Error(`Release gate state has a stale, forged, or invalid benchmark scorecard: ${path}`);
    }
  }
  const { mac: _mac, ...verified } = state;
  return verified;
}

function summarizeOutput(text) {
  return text.length <= 8_000 ? text : `${text.slice(0, 4_000)}\n... output truncated ...\n${text.slice(-4_000)}`;
}

function prerequisiteResult(gate, message, reason = "missing_script") {
  const output = `${message}\n`;
  const timestamp = new Date().toISOString();
  return {
    id: gate.id, status: "prerequisite", reason, exitCode: 2,
    startedAt: timestamp, completedAt: timestamp, durationMs: 0,
    outputBytes: Buffer.byteLength(output), outputSha256: sha256(output), testSkips: 0, output,
  };
}

async function executeGate(gate, sourceRoot, scripts, context, spawnRunner = spawn) {
  if (gate.script && typeof scripts[gate.script] !== "string") {
    return prerequisiteResult(gate, `Tagged source is missing required release script: ${gate.script}`);
  }
  const pack = benchmarkPackForGate(gate);
  if (pack) {
    const validation = validateBenchmarkSourceScript(pack, scripts);
    if (!validation.ok) return prerequisiteResult(gate, `Tagged source has a stale benchmark script: ${gate.script}`, validation.reason);
  }
  const command = gate.command ?? npmCommand;
  const reporterDirectory = pack ? mkdtempSync(join(tmpdir(), "lax-release-benchmark-")) : undefined;
  const reporterFile = reporterDirectory ? join(reporterDirectory, "vitest.json") : undefined;
  const args = gate.args ?? [...npmPrefix, "run", gate.script, ...(reporterFile ? benchmarkReporterArgs(reporterFile) : [])];
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let child;
  try {
    child = spawnRunner(command, args, {
      cwd: sourceRoot, env: process.env, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (reporterDirectory) rmSync(reporterDirectory, { recursive: true, force: true });
    throw error;
  }
  const chunks = [];
  child.stdout?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  const closed = new Promise((resolveExit) => {
    child.once("close", (codeValue, signalValue) => resolveExit({ code: codeValue, signal: signalValue }));
  });
  let timer;
  const deadline = new Promise((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline({ timedOut: true }), gate.timeoutMs);
  });
  const first = await Promise.race([closed, deadline]);
  let timedOut = first.timedOut === true;
  let outcome = first;
  if (timedOut) {
    try { await terminateProcessTree(child); }
    catch (error) {
      if (reporterDirectory) rmSync(reporterDirectory, { recursive: true, force: true });
      throw error;
    }
    outcome = await Promise.race([
      closed,
      new Promise((resolveBound) => setTimeout(() => resolveBound({ code: null, signal: "cleanup_bound" }), 1_000)),
    ]);
  } else {
    clearTimeout(timer);
  }
  const { code, signal } = outcome;
  const rawOutput = Buffer.concat(chunks).toString("utf8");
  const output = summarizeOutput(`${rawOutput}${spawnError?.message ?? ""}`);
  const skipSummaries = [...output.matchAll(/^\s*Tests\s+.*?\b(\d+) skipped\b/gm)];
  let testSkips = skipSummaries.length ? Number(skipSummaries.at(-1)[1]) : 0;
  let status = "failed";
  let reason = `exit_${code ?? "missing"}`;
  if (timedOut || signal) {
    status = "timeout";
    reason = timedOut ? "timeout" : `signal_${signal}`;
  } else if (spawnError) {
    reason = `spawn_${spawnError.code ?? "error"}`;
  } else if (code === 0) {
    status = "passed";
    reason = "exit_0";
  } else if (code === 2) {
    status = "prerequisite";
    reason = "exit_2";
  } else if (code === 77) {
    status = gate.allowPlatformSkip ? "platform_skip" : "failed";
    reason = gate.allowPlatformSkip ? "explicit_platform_skip" : "unauthorized_platform_skip";
  }
  const completedAt = new Date().toISOString();
  let benchmarkEvidence;
  if (pack) {
    try {
      try {
        benchmarkEvidence = await buildBenchmarkEvidence(pack, reporterFile, {
          ...context, sourceRoot, outputSha256: sha256(rawOutput), completedAt,
        });
      } catch (error) {
        try {
          benchmarkEvidence = await buildBenchmarkEvidence(pack, `${reporterFile}.unavailable`, {
            ...context, sourceRoot, outputSha256: sha256(rawOutput), completedAt,
          });
        } catch {
          benchmarkEvidence = {
            scorecard: null, results: [], disposition: { allowed: [], blocked: [] },
            reporterSha256: `sha256:${sha256("unavailable")}`, reportedFiles: 0,
          };
        }
        benchmarkEvidence.error = "benchmark evidence transformation failed";
      }
    } finally {
      rmSync(reporterDirectory, { recursive: true, force: true });
    }
    testSkips = benchmarkEvidence.disposition.allowed.length + benchmarkEvidence.disposition.blocked.length;
    if (status === "passed" && benchmarkEvidence.scorecard?.verdict !== "pass") {
      status = "failed";
      reason = benchmarkEvidence.error ? "malformed_benchmark_evidence"
        : benchmarkEvidence.disposition.blocked.length ? "unrecognized_benchmark_skip" : "incomplete_benchmark_evidence";
    }
  }
  return {
    id: gate.id, status, reason, exitCode: code, startedAt,
    completedAt, durationMs: Date.now() - start,
    outputBytes: Buffer.byteLength(rawOutput), outputSha256: sha256(rawOutput), testSkips,
    output: pack ? "Benchmark output retained as a content-free digest." : output,
    benchmarkEvidence,
  };
}

export async function runReleaseGate({
  gates = releaseGates, sourceRoot = toolingRoot, reportPath, statePath, resume = false,
  key = process.env.LAX_RELEASE_GATE_RESUME_KEY, environment, expectedToolingRevision, spawnRunner,
} = {}) {
  validateGates(gates);
  const root = resolve(sourceRoot);
  const sourceRevision = gitRevision(root, "Release source");
  const toolingRevision = gitRevision(toolingRoot, "Release tooling");
  if (expectedToolingRevision && toolingRevision !== expectedToolingRevision.toLowerCase()) {
    throw new Error(`Release tooling revision mismatch: expected ${expectedToolingRevision}, got ${toolingRevision}`);
  }
  const digest = runnerDigest();
  const runtime = executionEnvironment(environment);
  const sourcePackage = readSourcePackage(root);
  const scripts = sourcePackage.scripts;
  const report = reportPath ? resolve(reportPath) : resolve(root, ".release-gate", "report.json");
  const stateFile = statePath ? resolve(statePath) : resolve(root, ".release-gate", "state.json");
  const fingerprint = sha256(JSON.stringify({ sourceRevision, toolingRevision, runnerDigest: digest, runtime, gates }));
  const signingKey = resumeKey(key);
  if (resume && !signingKey) throw new Error("Release gate resume requires LAX_RELEASE_GATE_RESUME_KEY");
  const state = resume
    ? await readState(stateFile, fingerprint, gates, signingKey, {
      sourceRevision, toolingRevision, runtime, packageVersion: sourcePackage.version,
    })
    : { schema: RELEASE_GATE_SCHEMA, fingerprint, evidence: [] };
  const results = [];
  let blocked = false;

  for (const gate of gates) {
    const receipt = state.evidence.find((item) => item.id === gate.id);
    if (receipt) {
      results.push({ id: gate.id, status: "resumed", reason: "authenticated_receipt", receipt });
      continue;
    }
    const result = await executeGate(gate, root, scripts, {
      sourceRevision, toolingRevision, runtime, packageVersion: sourcePackage.version,
    }, spawnRunner);
    results.push(result);
    if (result.status === "passed" || result.status === "platform_skip") {
      state.evidence.push({
        id: result.id, status: result.status, exitCode: result.exitCode,
        outputBytes: result.outputBytes, outputSha256: result.outputSha256,
        testSkips: result.testSkips, completedAt: result.completedAt,
        ...(result.benchmarkEvidence ? { benchmarkEvidence: result.benchmarkEvidence } : {}),
      });
      if (signingKey) atomicJson(stateFile, signedState(state, signingKey));
    } else {
      blocked = true;
      break;
    }
  }

  const value = {
    schema: RELEASE_GATE_SCHEMA,
    status: blocked || state.evidence.length !== gates.length ? "blocked" : "passed",
    sourceRevision, toolingRevision, runnerDigest: digest, environment: runtime,
    fingerprint, generatedAt: new Date().toISOString(), results,
  };
  atomicJson(report, value);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const result = await runReleaseGate({
      sourceRoot: options.sourceRoot, reportPath: options.report, statePath: options.state,
      resume: options.resume, expectedToolingRevision: options.toolingRevision,
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === "passed" ? 0 : 1;
  } catch (error) {
    const result = { schema: RELEASE_GATE_SCHEMA, status: "blocked", error: String(error?.message ?? error) };
    if (options) {
      const report = options.report ?? resolve(options.sourceRoot, ".release-gate", "report.json");
      try { atomicJson(report, result); }
      catch (reportError) { result.reportError = String(reportError?.message ?? reportError); }
    }
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  }
}

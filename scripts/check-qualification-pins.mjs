#!/usr/bin/env node
/**
 * The release gate's benchmark pins must match their test files.
 *
 * Each scenario in scripts/local-qualification/benchmark-packs.mjs pins its test
 * file's assertion count and a hash of the sorted assertion names. A test added
 * to one of those files without a refreshed pin passes every ordinary check and
 * then fails the tagged release ("malformed_benchmark_evidence"), days later.
 * This runs every pinned file once, the way the gate reads it (the vitest JSON
 * reporter), and fails on any pin that no longer matches, so the drift shows
 * on the push that caused it.
 *
 *   node scripts/check-qualification-pins.mjs           check (CI)
 *   node scripts/check-qualification-pins.mjs --write   refresh the stale pins,
 *     bumping the scenario's and its pack's version as earlier refreshes did
 *
 * The local-model files read config/app-manifest.json: run `npm run test:prepare` first.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { qualificationBenchmarkCatalog } from "./local-qualification/benchmark-packs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CATALOG = join(ROOT, "scripts", "local-qualification", "benchmark-packs.mjs");
const WRITE = process.argv.includes("--write");
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const scenarios = qualificationBenchmarkCatalog.packs.flatMap((pack) => pack.scenarios.map((s) => ({ pack: pack.id, ...s })));
const dir = mkdtempSync(join(tmpdir(), "lax-qual-pins-"));
const reportPath = join(dir, "report.json");
const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const run = spawnSync(process.execPath, [vitest, "run", ...scenarios.map((s) => s.testPath), "--reporter=json", `--outputFile=${reportPath}`], {
	cwd: ROOT, stdio: ["ignore", "ignore", "inherit"],
});
let report;
try {
	report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch {
	console.error(`check-qualification-pins: vitest wrote no report (exit ${run.status}).`);
	process.exit(1);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

const results = new Map(report.testResults.map((r) => [relative(ROOT, r.name).split(sep).join("/"), r]));
const stale = [];
const failing = [];
for (const s of scenarios) {
	const result = results.get(s.testPath);
	if (!result) { failing.push(`${s.pack}/${s.id}: ${s.testPath} produced no result`); continue; }
	const names = result.assertionResults.map((a) => sha256(a.fullName)).sort();
	const notPassed = result.assertionResults.filter((a) => a.status !== "passed").length;
	if (notPassed) failing.push(`${s.pack}/${s.id}: ${notPassed} of ${names.length} assertions did not pass in ${s.testPath}`);
	const hash = sha256(JSON.stringify(names));
	if (names.length !== s.assertionCount || hash !== s.assertionManifestSha256) {
		stale.push({ ...s, count: names.length, hash });
	}
}

if (failing.length) {
	console.error("check-qualification-pins: a pinned scenario's tests are not green:");
	for (const f of failing) console.error(`  ${f}`);
	process.exit(1);
}
if (!stale.length) {
	console.log(`check-qualification-pins: OK (${scenarios.length} scenarios match their pins)`);
	process.exit(0);
}
if (!WRITE) {
	console.error("check-qualification-pins: these release-gate pins no longer match their test files:");
	for (const s of stale) console.error(`  ${s.pack}/${s.id} (${s.testPath}): ${s.count} assertions, pinned ${s.assertionCount}`);
	console.error("  Every tagged release would fail its gate. Refresh them: npm run check:qualification-pins -- --write");
	process.exit(1);
}

let source = readFileSync(CATALOG, "utf8");
const bump = (line, pattern) => line.replace(pattern, (_, head, n) => `${head}${Number(n) + 1}`);
for (const s of stale) {
	const lines = source.split("\n");
	const i = lines.findIndex((l) => l.includes(`testPath: "${s.testPath}"`));
	lines[i] = bump(lines[i], /(id: "[^"]+", version: )(\d+)/)
		.replace(/assertionCount: \d+/, `assertionCount: ${s.count}`)
		.replace(/assertionManifestSha256: "sha256:[0-9a-f]+"/, `assertionManifestSha256: "${s.hash}"`);
	source = lines.join("\n");
}
for (const packId of new Set(stale.map((s) => s.pack))) {
	source = bump(source, new RegExp(`(schemaVersion: 1, id: "${packId}", version: )(\\d+)`));
}
writeFileSync(CATALOG, source);
console.log(`check-qualification-pins: refreshed ${stale.length} pin(s): ${stale.map((s) => `${s.pack}/${s.id}`).join(", ")}`);

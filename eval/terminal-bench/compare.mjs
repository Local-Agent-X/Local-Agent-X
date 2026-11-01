#!/usr/bin/env node
/**
 * Score Harbor jobs, and say whether two of them really differ.
 *
 * Harbor's job summary gives a mean and nothing else, and a one-attempt run of
 * 89 tasks moves by a few tasks from run to run on its own: a lead of one task
 * is noise. This reads each trial's verifier reward (never the exception: a
 * timed-out trial can still pass), and reports:
 *
 *   - per side: the pass rate over tasks with a verdict, with a 95% interval
 *     from resampling TASKS (attempts of one task are not independent, so with
 *     -k > 1 the task is the unit), and how many tasks passed at least once;
 *   - for two sides, on the tasks both have a verdict for: the paired
 *     difference with its 95% interval, the tasks only one side passes, and
 *     with one attempt per task the exact McNemar p-value on those;
 *   - trials with no verdict (the verifier never ran: an infrastructure
 *     failure, not the agent's), listed apart and left out of both rates.
 *
 * A side is one or more job directories, merged (a run split across two jobs).
 *
 *   node eval/terminal-bench/compare.mjs --a <job>[,<job>] [--b <job>[,<job>]]
 *        [--label-a LAX] [--label-b Hermes] [--json]
 *
 * Pure functions (readJob, scoreSide, compareSides) are exported for the test.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_ROUNDS = 10_000;

/** trial results of one job dir: [{ task, reward|null }] */
export function readJob(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "result.json");
    if (!statSync(join(dir, name)).isDirectory() || !existsSync(file)) continue;
    let d;
    try { d = JSON.parse(readFileSync(file, "utf-8")); } catch { continue; }
    const task = d.task_name || name.split("__")[0];
    const r = d.verifier_result?.rewards?.reward;
    out.push({ task, reward: typeof r === "number" ? r : null });
  }
  return out;
}

/** task → rewards of its attempts that got a verdict; noVerdict lists the rest */
function byTask(trials) {
  const tasks = new Map();
  const noVerdict = new Set();
  for (const t of trials) {
    if (t.reward === null) { noVerdict.add(t.task); continue; }
    if (!tasks.has(t.task)) tasks.set(t.task, []);
    tasks.get(t.task).push(t.reward);
  }
  for (const task of tasks.keys()) noVerdict.delete(task);
  return { tasks, noVerdict: [...noVerdict].sort() };
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Seeded so a report reads the same every time it is run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 95% percentile interval of mean(values) over resampled tasks. */
function bootstrap(values, seed = 1) {
  if (values.length === 0) return [NaN, NaN];
  const next = rng(seed);
  const means = [];
  for (let i = 0; i < BOOTSTRAP_ROUNDS; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(next() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * BOOTSTRAP_ROUNDS)], means[Math.floor(0.975 * BOOTSTRAP_ROUNDS) - 1]];
}

export function scoreSide(trials) {
  const { tasks, noVerdict } = byTask(trials);
  const perTask = new Map([...tasks].map(([task, rs]) => [task, mean(rs)]));
  const values = [...perTask.values()];
  const attempts = [...tasks.values()].map((rs) => rs.length);
  return {
    tasks: values.length,
    attempts: { min: Math.min(...attempts), max: Math.max(...attempts) },
    passed: values.reduce((s, v) => s + v, 0),
    rate: values.length ? mean(values) : NaN,
    ci95: bootstrap(values),
    passedOnce: [...tasks.values()].filter((rs) => rs.some((r) => r >= 1)).length,
    noVerdict,
    perTask,
  };
}

/** Two-sided exact McNemar: discordant pairs n01, n10 against Binomial(n, 1/2). */
export function mcnemarExact(n01, n10) {
  const n = n01 + n10;
  if (n === 0) return 1;
  const k = Math.min(n01, n10);
  let p = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    p += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * p) / 2 ** n);
}

export function compareSides(a, b) {
  const common = [...a.perTask.keys()].filter((t) => b.perTask.has(t)).sort();
  const diffs = common.map((t) => a.perTask.get(t) - b.perTask.get(t));
  const onlyA = common.filter((t) => a.perTask.get(t) > b.perTask.get(t));
  const onlyB = common.filter((t) => b.perTask.get(t) > a.perTask.get(t));
  const single = a.attempts.max === 1 && b.attempts.max === 1;
  const ci95 = bootstrap(diffs, 2);
  return {
    common: common.length,
    aRate: common.length ? mean(common.map((t) => a.perTask.get(t))) : NaN,
    bRate: common.length ? mean(common.map((t) => b.perTask.get(t))) : NaN,
    diff: diffs.length ? mean(diffs) : NaN,
    ci95,
    onlyA,
    onlyB,
    mcnemarP: single ? mcnemarExact(onlyA.length, onlyB.length) : null,
    withinNoise: !(ci95[0] > 0 || ci95[1] < 0),
  };
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;

function renderSide(label, s) {
  const k = s.attempts.min === s.attempts.max ? `${s.attempts.max}` : `${s.attempts.min}-${s.attempts.max}`;
  const lines = [
    `${label}: ${s.passed.toFixed(s.attempts.max > 1 ? 1 : 0)} / ${s.tasks} tasks = ${pct(s.rate)} (95% CI ${pct(s.ci95[0])}–${pct(s.ci95[1])}), attempts per task ${k}`,
  ];
  if (s.attempts.max > 1) lines.push(`  passed at least once: ${s.passedOnce} / ${s.tasks}`);
  if (s.noVerdict.length) lines.push(`  no verdict (infrastructure, left out): ${s.noVerdict.join(", ")}`);
  return lines.join("\n");
}

export function render(labelA, a, labelB, b, cmp) {
  const out = [renderSide(labelA, a)];
  if (!b) return out.join("\n");
  out.push(renderSide(labelB, b));
  out.push("");
  out.push(`Paired, on the ${cmp.common} tasks both have a verdict for: ${labelA} ${pct(cmp.aRate)} vs ${labelB} ${pct(cmp.bRate)}`);
  out.push(`  difference ${cmp.diff >= 0 ? "+" : ""}${pct(cmp.diff)} (95% CI ${pct(cmp.ci95[0])} to ${pct(cmp.ci95[1])})${cmp.mcnemarP === null ? "" : `, McNemar p = ${cmp.mcnemarP.toFixed(3)}`}`);
  out.push(`  ${cmp.withinNoise ? "Within noise: the interval includes no difference." : `${cmp.diff > 0 ? labelA : labelB} is ahead beyond noise.`}`);
  out.push(`  only ${labelA} passes (${cmp.onlyA.length}): ${cmp.onlyA.join(", ") || "none"}`);
  out.push(`  only ${labelB} passes (${cmp.onlyB.length}): ${cmp.onlyB.join(", ") || "none"}`);
  return out.join("\n");
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function loadSide(spec) {
  return spec.split(",").flatMap((d) => readJob(resolve(d.trim())));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const specA = arg("--a");
  if (!specA) {
    console.error("usage: compare.mjs --a <job>[,<job>] [--b <job>[,<job>]] [--label-a A] [--label-b B] [--json]");
    process.exit(2);
  }
  const specB = arg("--b");
  const labelA = arg("--label-a") || "A", labelB = arg("--label-b") || "B";
  const a = scoreSide(loadSide(specA));
  const b = specB ? scoreSide(loadSide(specB)) : null;
  const cmp = b ? compareSides(a, b) : null;
  if (process.argv.includes("--json")) {
    const plain = (s) => s && { ...s, perTask: Object.fromEntries(s.perTask) };
    console.log(JSON.stringify({ [labelA]: plain(a), ...(b ? { [labelB]: plain(b), compare: cmp } : {}) }, null, 2));
  } else {
    console.log(render(labelA, a, labelB, b, cmp));
  }
}

#!/usr/bin/env node
// Which commands in a task set's reference solutions would LAX's security
// layer refuse? Runs each statement of every `solution/solve.sh` through
// SecurityLayer.evaluate as a `bash` call, the way a chat turn's shell call
// reaches it, and groups the refusals by rule. No model, no GPU.
//
// Run it where the rules are the Linux ones: inside a Linux container with
// the bundle (bundle.mjs) unpacked, e.g.
//
//   node eval/terminal-bench/policy-scan.mjs --tasks /tasks --out /out/scan.json [--desktop]
//
// Default settings are the benchmark seed's (seed.mjs: unrestricted file
// access, the disposable-sandbox switch, LAX_SANDBOX=host). --desktop scans
// as a default install on a Linux machine where LAX's sandbox cannot start.
//
// Use it to find CLASSES of over-blocking, then justify each change with a
// real-user case. A rule bent to fit one task's solution is tuning to the test.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const desktop = process.argv.includes("--desktop");
const tasksDir = resolve(arg("tasks", "."));
const outPath = arg("out", "policy-scan.json");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The settings the layer reads at construction and per call.
const dataDir = mkdtempSync(join(tmpdir(), "lax-scan-"));
process.env.LAX_DATA_DIR = dataDir;
process.env.LAX_SANDBOX = "host";
const security = desktop ? {} : { fileAccessMode: "unrestricted", disposableSandbox: true };
writeFileSync(join(dataDir, "security.json"), JSON.stringify(security));

const { SecurityLayer } = await import(pathToFileURL(join(repoRoot, "dist/security/layer/layer-core.js")).href);
const layer = new SecurityLayer("/app");

/** Split a bash script into the statements a model would send one call at a time. */
export function statements(script) {
  const out = [];
  let buf = [];
  let depth = 0;
  let parens = 0;
  let heredoc = null;
  for (const raw of script.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (heredoc) {
      buf.push(line);
      if (line.trim() === heredoc) heredoc = null;
      if (!heredoc && depth === 0) { out.push(buf.join("\n")); buf = []; }
      continue;
    }
    const t = line.trim();
    if (buf.length === 0 && (t === "" || t.startsWith("#"))) continue;
    buf.push(line);
    const h = t.match(/<<-?\s*['"]?(\w+)['"]?/);
    if (h) { heredoc = h[1]; continue; }
    depth += (t.match(/^(if|for|while|until|case)\b|\bthen$|\bdo$/g) ?? []).filter((w) => /^(if|for|while|until|case)/.test(w)).length;
    depth -= (t.match(/\b(fi|done|esac)\b/g) ?? []).length;
    if (/\(\)\s*\{$/.test(t) || /^function\s/.test(t)) depth++;
    if (t === "}") depth--;
    if (depth < 0) depth = 0;
    // A `$(` or `(` left open runs on to the line that closes it.
    const unquoted = t.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "");
    parens = Math.max(0, parens + (unquoted.match(/\(/g) ?? []).length - (unquoted.match(/\)/g) ?? []).length);
    if (t.endsWith("\\") || depth > 0 || parens > 0) continue;
    out.push(buf.join("\n"));
    buf = [];
  }
  if (buf.length) out.push(buf.join("\n"));
  return out;
}

const tasks = readdirSync(tasksDir).filter((t) => existsSync(join(tasksDir, t, "solution", "solve.sh"))).sort();
const results = [];
for (const task of tasks) {
  const script = readFileSync(join(tasksDir, task, "solution", "solve.sh"), "utf8");
  for (const command of statements(script)) {
    const d = layer.evaluate({ toolName: "bash", args: { command }, sessionId: "scan", callContext: "api" });
    if (!d.allowed) results.push({ task, command: command.slice(0, 400), reason: d.reason });
  }
}

// Group by rule: the reason with its variable parts (paths, names, numbers) folded.
const fold = (r) => String(r).replace(/"[^"]*"/g, '"X"').replace(/`[^`]*`/g, "`X`").replace(/\d+/g, "N").slice(0, 140);
const byRule = new Map();
for (const r of results) {
  const k = fold(r.reason);
  const e = byRule.get(k) ?? { rule: k, count: 0, tasks: new Set(), example: r };
  e.count++; e.tasks.add(r.task); byRule.set(k, e);
}
const rules = [...byRule.values()].sort((a, b) => b.tasks.size - a.tasks.size)
  .map((e) => ({ rule: e.rule, statements: e.count, tasks: [...e.tasks], example: { task: e.example.task, command: e.example.command.slice(0, 200) } }));
const blockedTasks = new Set(results.map((r) => r.task));
writeFileSync(outPath, JSON.stringify({ settings: desktop ? "desktop (default install, no sandbox)" : "benchmark seed", tasks: tasks.length, tasksWithABlock: blockedTasks.size, rules, results }, null, 2));
console.log(`${desktop ? "desktop" : "benchmark"}: ${blockedTasks.size} of ${tasks.length} tasks have at least one refused statement; ${rules.length} rules`);
for (const r of rules) console.log(`${String(r.tasks.length).padStart(3)} tasks ${String(r.statements).padStart(4)} stmts  ${r.rule}`);
// Modules the layer imports keep timers alive; the scan is done.
process.exit(0);

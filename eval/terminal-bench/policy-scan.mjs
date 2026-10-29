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
//   node eval/terminal-bench/policy-scan.mjs --replay /jobs/<job> --out /out/replay.json
//
// --replay judges the shell commands a LAX run's model actually sent (every
// bash / process_start call in each trial's saved session) instead of the
// reference solutions: what today's rules would still refuse of real work.
//
//   node eval/terminal-bench/policy-scan.mjs --trajectories /jobs/<a>,/jobs/<b> --out /out/cross.json
//
// --trajectories does the same for OTHER harnesses' runs, from the trajectory
// Harbor saves for each trial (agent/trajectory.json, ATIF): every command
// Hermes or Codex sent, none of which any gate stopped. What LAX would refuse
// of them is a false alarm waiting for LAX's model to try the same thing.
// Hermes' execute_code is translated to the `python3 - <<'PY'` a LAX model
// writes for it, and marked so. OpenClaw's trajectory holds no tool calls.
// Each call also goes through the approval floor and the unnamed-delete gate;
// those read the disk, which a replay does not have, so a delete they ask
// about here may have been provable in the trial.
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

/** The shell commands a LAX run actually sent: every bash / process_start call
 *  in each trial's saved session (lax-data/sessions/*.jsonl). */
function* sessionCommands(jobDir) {
  for (const trial of readdirSync(jobDir)) {
    const sessions = join(jobDir, trial, "agent", "lax-data", "sessions");
    if (!existsSync(sessions)) continue;
    for (const f of readdirSync(sessions).filter((n) => n.endsWith(".jsonl") && !n.startsWith("."))) {
      for (const line of readFileSync(join(sessions, f), "utf8").split("\n")) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        for (const tc of (m.message ?? m).tool_calls ?? []) {
          const name = tc.function?.name ?? tc.name;
          if (name !== "bash" && name !== "process_start") continue;
          let args = tc.function?.arguments ?? tc.arguments ?? tc.input;
          try { if (typeof args === "string") args = JSON.parse(args); } catch { continue; }
          if (typeof args?.command === "string") yield { task: trial.split("__")[0], toolName: name, command: args.command };
        }
      }
    }
  }
}

/** A harness's shell call as the LAX call its model would make instead. */
const TRAJECTORY_SHELL = {
  terminal: (a) => a.command && { toolName: a.background ? "process_start" : "bash", command: a.command },
  exec_command: (a) => a.cmd && { toolName: "bash", command: Array.isArray(a.cmd) ? a.cmd.join(" ") : a.cmd },
  execute_code: (a) => a.code && { toolName: "bash", command: `python3 - <<'PY'\n${a.code}\nPY`, translated: true },
};

/** Every shell call in a job's trajectories: `{ harness, task, toolName, command, translated? }`. */
function* trajectoryCommands(jobDir) {
  for (const trial of readdirSync(jobDir)) {
    const path = join(jobDir, trial, "agent", "trajectory.json");
    if (!existsSync(path)) continue;
    let t;
    try { t = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const harness = String(t.agent?.name ?? "unknown").toLowerCase();
    for (const step of t.steps ?? []) {
      for (const tc of step.tool_calls ?? []) {
        const call = TRAJECTORY_SHELL[tc.function_name]?.(tc.arguments ?? {});
        if (call && typeof call.command === "string") yield { harness, task: trial.split("__")[0], ...call };
      }
    }
  }
}

// The approval gates a bash call meets after the security layer, as the
// Autonomous profile the benchmark seed sets runs them.
const { applyIrreversibleFloor } = await import(pathToFileURL(join(repoRoot, "dist/approval-decision.js")).href);
const { unnamedDeletes } = await import(pathToFileURL(join(repoRoot, "dist/tool-execution/unnamed-delete-gate.js")).href);
function approvalAsk(toolName, command) {
  const args = { command };
  if (applyIrreversibleFloor("allow-with-rollback", toolName, args, undefined, { cwd: "/app", sessionId: "scan" }) === "ask") return "irreversible floor";
  const unnamed = unnamedDeletes([{ id: "x", name: toolName, arguments: JSON.stringify(args) }], [{ role: "user", content: "Do the task." }], { sessionId: "scan" });
  return unnamed.length ? `unnamed delete: ${unnamed.map((d) => d.path).join(", ")}` : null;
}

// --replay <job dir>: judge what a run's model actually ran, not the reference.
const replayDir = arg("replay", null);
const trajectoryDirs = arg("trajectories", null)?.split(",").filter(Boolean) ?? null;
const results = [];
let tasks;
if (trajectoryDirs) {
  const seen = new Set();
  const judged = new Set();
  let calls = 0;
  for (const dir of trajectoryDirs) {
    for (const c of trajectoryCommands(resolve(dir))) {
      seen.add(c.task);
      const key = `${c.task}\0${c.toolName}\0${c.command}`;
      if (judged.has(key)) continue;
      judged.add(key); calls++;
      const d = layer.evaluate({ toolName: c.toolName, args: { command: c.command }, sessionId: "scan", callContext: "api" });
      const ask = d.allowed ? approvalAsk(c.toolName, c.command) : null;
      if (!d.allowed || ask) {
        results.push({ harness: c.harness, task: c.task, gate: d.allowed ? "approval" : "security", translated: c.translated === true, command: c.command.slice(0, 600), reason: d.allowed ? ask : d.reason });
      }
    }
  }
  tasks = [...seen];
  console.log(`${calls} distinct shell calls from ${trajectoryDirs.length} job(s)`);
} else if (replayDir) {
  const seen = new Set();
  for (const { task, toolName, command } of sessionCommands(resolve(replayDir))) {
    seen.add(task);
    const d = layer.evaluate({ toolName, args: { command }, sessionId: "scan", callContext: "api" });
    if (!d.allowed) results.push({ task, command: command.slice(0, 400), reason: d.reason });
  }
  tasks = [...seen];
} else {
  tasks = readdirSync(tasksDir).filter((t) => existsSync(join(tasksDir, t, "solution", "solve.sh"))).sort();
  for (const task of tasks) {
    const script = readFileSync(join(tasksDir, task, "solution", "solve.sh"), "utf8");
    for (const command of statements(script)) {
      const d = layer.evaluate({ toolName: "bash", args: { command }, sessionId: "scan", callContext: "api" });
      if (!d.allowed) results.push({ task, command: command.slice(0, 400), reason: d.reason });
    }
  }
}

// Group by rule: the reason with its variable parts (paths, names, numbers) folded.
const fold = (r) => String(r).replace(/"[^"]*"/g, '"X"').replace(/`[^`]*`/g, "`X`").replace(/(unnamed delete: ).*/, "$1…").replace(/\d+/g, "N").slice(0, 140);
const byRule = new Map();
for (const r of results) {
  const k = `${r.gate ? `[${r.gate}] ` : ""}${fold(r.reason)}`;
  const e = byRule.get(k) ?? { rule: k, count: 0, tasks: new Set(), harnesses: new Set(), examples: [] };
  e.count++; e.tasks.add(r.task); if (r.harness) e.harnesses.add(r.harness);
  if (e.examples.length < 5) e.examples.push({ task: r.task, harness: r.harness, translated: r.translated, command: r.command.slice(0, 300) });
  byRule.set(k, e);
}
const rules = [...byRule.values()].sort((a, b) => b.tasks.size - a.tasks.size)
  .map((e) => ({ rule: e.rule, statements: e.count, tasks: [...e.tasks], harnesses: [...e.harnesses], examples: e.examples }));
// Each rule's first example stands for it in the summary line below.
for (const r of rules) r.example = r.examples[0];
const blockedTasks = new Set(results.map((r) => r.task));
writeFileSync(outPath, JSON.stringify({ settings: desktop ? "desktop (default install, no sandbox)" : "benchmark seed", tasks: tasks.length, tasksWithABlock: blockedTasks.size, rules, results }, null, 2));
console.log(`${desktop ? "desktop" : "benchmark"}: ${blockedTasks.size} of ${tasks.length} tasks have at least one refused statement; ${rules.length} rules`);
for (const r of rules) console.log(`${String(r.tasks.length).padStart(3)} tasks ${String(r.statements).padStart(4)} stmts  ${r.rule}`);
// Modules the layer imports keep timers alive; the scan is done.
process.exit(0);

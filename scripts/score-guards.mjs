#!/usr/bin/env node
// score-guards — what happened after each harness guard fired, in recorded runs.
//
//   node scripts/score-guards.mjs [--data DIR] [--since YYYY-MM-DD] [--session-mode code|all]
//                                 [--json] [--detail FILE]
//
// The turn loop's guards (src/canonical-loop/middlewares/, turn-loop/) inject a
// message into the model's view or re-open a finished turn. Each firing is a
// `middleware_fired` event in <data>/operations/<op>/canonical-events.jsonl.
// This reads those and the op's turns, makes NO model call, and reports, per
// guard and model family, mechanical signals of what the run did next. The
// signals say what followed a firing; whether the guard was RIGHT is a
// judgement the detail file exists to support.
//
// The table holds guard names, model families, counts and rates only, so it
// can be committed. Per-firing detail (op ids, clips of messages) is private
// run data: it is written only with --detail, to a path you choose.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dataDir, listOps } from "./lax-trace.mjs";

const VERIFY_CMD = /\b(tsc|tsgo|vitest|jest|pytest|eslint)\b|\b(npm|npx|pnpm|yarn|bun)\s+(run\s+)?(build|check|typecheck|lint|test)\b|\b(cargo|go)\s+(test|build)\b/i;
const EDIT_TOOLS = new Set(["write", "edit", "multi_edit", "edit_lines", "bulk_replace"]);
const STEP_LIST_TOOLS = new Set(["update_plan", "task_create", "task_update", "wrap_up"]);

export function modelFamily(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.startsWith("claude")) return "claude";
  if (/^(gpt|o\d)/.test(m)) return "gpt";
  if (m.startsWith("grok")) return "grok";
  if (m.startsWith("gemini")) return "gemini";
  return "local";
}

/** One step's tool calls as `{ name, key, ok, command }`, from a turn's messages. */
export function stepCalls(turn) {
  const status = new Map();
  for (const m of turn?.messages ?? []) {
    if (m.role === "tool_result") status.set(m.content?.toolCallId, /^\[ok\b/.test(String(m.content?.result ?? "").slice(0, 8)));
  }
  const out = [];
  for (const m of turn?.messages ?? []) {
    if (m.role !== "assistant") continue;
    for (const c of m.content?.toolCalls ?? []) {
      let command = "";
      try { command = String(JSON.parse(c.arguments ?? "{}").command ?? ""); } catch { /* arguments are not JSON: no command to read */ }
      out.push({ name: c.name, key: `${c.name}:${c.arguments ?? ""}`, ok: status.get(c.id) !== false, command });
    }
  }
  return out;
}

/**
 * What followed one firing. `steps` is the op's turns as arrays of calls
 * (stepCalls), indexed by step; `at` is the step the guard fired on.
 */
export function scoreFiring(steps, at, guard) {
  const after = steps.slice(at + 1);
  const before = steps.slice(Math.max(0, at - 1), at + 1).flat();
  const next2 = after.slice(0, 2).flat();
  const seenBefore = new Set(before.map((c) => c.key));
  const score = {
    stepsAfter: after.length,
    endedWithin3: after.length <= 3,
    changedApproach: next2.length > 0 && next2.some((c) => !seenBefore.has(c.key) && !before.some((b) => b.name === c.name)),
  };
  const later = after.flat();
  if (guard === "tool-failure-summary") {
    const failed = new Set(steps[at]?.filter((c) => !c.ok).map((c) => c.name) ?? []);
    score.specific = failed.size > 0 && later.some((c) => failed.has(c.name) && c.ok);
  } else if (guard === "verify-gate" || guard === "build-verify") {
    score.specific = after.slice(0, 3).flat().some((c) => VERIFY_CMD.test(c.command));
  } else if (guard === "spec-audit" || guard === "spec-probe" || guard === "regression-audit") {
    score.specific = later.some((c) => EDIT_TOOLS.has(c.name));
  } else if (guard === "open-steps") {
    score.specific = later.some((c) => STEP_LIST_TOOLS.has(c.name));
  } else if (guard === "budget-ladder") {
    // Flat = no call in the stretch since the previous quarter that the run had not made before it.
    const span = Math.max(1, Math.round(at / 2));
    const earlier = new Set(steps.slice(0, Math.max(0, at - span)).flat().map((c) => c.key));
    score.specific = !steps.slice(Math.max(0, at - span), at + 1).flat().some((c) => !earlier.has(c.key));
  }
  return score;
}

/** What `specific` means for a guard, for the table's last column. */
export const SPECIFIC = {
  "tool-failure-summary": "the failed tool later succeeded",
  "verify-gate": "a build, type-check or test ran within 3 steps",
  "build-verify": "a build, type-check or test ran within 3 steps",
  "spec-audit": "the run edited a file afterwards",
  "spec-probe": "the run edited a file afterwards",
  "regression-audit": "the run edited a file afterwards",
  "open-steps": "a step-list tool was called afterwards",
  "budget-ladder": "the stretch before it had produced nothing new",
};

export function aggregate(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.guard}\u0000${r.family}`;
    const g = groups.get(key) ?? { guard: r.guard, family: r.family, fires: 0, ops: new Set(), ended: 0, changed: 0, specific: 0, specificOf: 0 };
    g.fires++; g.ops.add(r.op);
    if (r.endedWithin3) g.ended++;
    if (r.changedApproach) g.changed++;
    if (r.specific !== undefined) { g.specificOf++; if (r.specific) g.specific++; }
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, ops: g.ops.size }))
    .sort((a, b) => b.fires - a.fires || a.guard.localeCompare(b.guard));
}

const pct = (n, of) => (of === 0 ? "-" : `${Math.round((100 * n) / of)}%`);

export function renderTable(groups) {
  const lines = [
    "| Guard | Model family | Fires | Runs | Run ended within 3 steps | Next steps changed approach | Guard-specific signal |",
    "|---|---|---:|---:|---:|---:|---|",
  ];
  for (const g of groups) {
    const specific = g.specificOf ? `${pct(g.specific, g.specificOf)}: ${SPECIFIC[g.guard]}` : "";
    lines.push(`| ${g.guard} | ${g.family} | ${g.fires} | ${g.ops} | ${pct(g.ended, g.fires)} | ${pct(g.changed, g.fires)} | ${specific} |`);
  }
  return lines.join("\n");
}

function codeSessionIds(dir) {
  const ids = new Set();
  const root = join(dir, "sessions");
  if (!existsSync(root)) return ids;
  for (const f of readdirSync(root)) {
    if (!f.endsWith(".jsonl") || f.startsWith(".")) continue;
    const id = f.slice(0, -".jsonl".length);
    if (id.startsWith("ide-")) { ids.add(id); continue; }
    const text = readFileSync(join(root, f), "utf8");
    const nl = text.indexOf("\n");
    try { if (JSON.parse(nl < 0 ? text : text.slice(0, nl)).mode === "code") ids.add(id); } catch { /* not a session file */ }
  }
  return ids;
}

function firingsOf(opDir) {
  const path = join(opDir, "canonical-events.jsonl");
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes("middleware_fired")) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "middleware_fired" && e.body?.name) out.push({ guard: e.body.name, reason: e.body.reason, at: Number(e.body.turnIdx ?? 0) });
    } catch { /* a torn line: skip it */ }
  }
  return out;
}

const clip = (s, n) => { s = String(s ?? "").replace(/\s+/g, " "); return s.length > n ? `${s.slice(0, n)}…` : s; };

export function main(argv = process.argv.slice(2)) {
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = dataDir(argv);
  const since = flag("--since");
  const codeOnly = (flag("--session-mode") ?? "code") === "code";
  const code = codeOnly ? codeSessionIds(dir) : null;
  const rows = [];
  const detail = [];
  for (const entry of listOps(dir)) {
    const { op, turns, id } = entry;
    if (code && !code.has(op.sessionId)) continue;
    if (since && String(op.createdAt ?? "") < since) continue;
    const firings = firingsOf(entry.dir);
    if (firings.length === 0) continue;
    const steps = [];
    for (const t of turns) steps[t.idx] = stepCalls({ messages: t.messages ?? readTurnMessages(entry.dir, t.idx) });
    for (let i = 0; i < steps.length; i++) steps[i] ??= [];
    for (const f of firings) {
      const score = scoreFiring(steps, f.at, f.guard);
      rows.push({ guard: f.guard, family: modelFamily(op.model), op: id, ...score });
      detail.push(`- ${f.guard}${f.reason && f.reason !== f.guard ? ` (${f.reason})` : ""} · ${op.model} · ${id} step ${f.at} · ${score.stepsAfter} steps after · changed approach: ${score.changedApproach}${score.specific === undefined ? "" : ` · ${SPECIFIC[f.guard]}: ${score.specific}`} · task: ${clip(op.task, 90)}`);
    }
  }
  const groups = aggregate(rows);
  if (argv.includes("--json")) console.log(JSON.stringify(groups, null, 2));
  else console.log(`${rows.length} firings in ${new Set(rows.map((r) => r.op)).size} runs\n\n${renderTable(groups)}`);
  const detailPath = flag("--detail");
  if (detailPath) writeFileSync(detailPath, `# Guard firings, one per line (private run data)\n\n${detail.join("\n")}\n`);
  return groups;
}

function readTurnMessages(opDir, idx) {
  try { return JSON.parse(readFileSync(join(opDir, "op-turns", `${idx}.json`), "utf8")).messages ?? []; } catch { return []; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

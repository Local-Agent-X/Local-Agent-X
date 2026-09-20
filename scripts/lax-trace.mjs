#!/usr/bin/env node
// lax-trace — step through what the model was sent and what came back.
//
//   node scripts/lax-trace.mjs list [--data DIR] [--run RUNID] [--limit N]
//   node scripts/lax-trace.mjs show <opId> [--data DIR] [--turn N] [--prompt] [--json]
//   node scripts/lax-trace.mjs diff <opA> <opB> [--data DIR]
//
// Reads the op store only: <data>/operations/<opId>/{operation.json, op-turns/N.json,
// op-turns/N.trace.json.gz}. DIR defaults to $LAX_DATA_DIR, then ~/.lax. An opId
// may be any unique suffix of the real id.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

export function dataDir(argv) {
  const i = argv.indexOf("--data");
  return i >= 0 ? argv[i + 1] : process.env.LAX_DATA_DIR || join(homedir(), ".lax");
}

function flag(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }
function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }

/** Every turn of one op: the committed row plus its trace when present. */
export function readTurns(opDir) {
  const dir = join(opDir, "op-turns");
  if (!existsSync(dir)) return [];
  const idxs = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => a - b);
  return idxs.map((idx) => {
    const row = readJson(join(dir, `${idx}.json`))?.turn ?? null;
    let trace = null;
    const tracePath = join(dir, `${idx}.trace.json.gz`);
    if (existsSync(tracePath)) { try { trace = JSON.parse(gunzipSync(readFileSync(tracePath)).toString("utf8")); } catch {} }
    return { idx, row, trace };
  });
}

export function readOp(dir, id) {
  const opDir = join(dir, "operations", id);
  const op = readJson(join(opDir, "operation.json"));
  return op ? { id, dir: opDir, op, turns: readTurns(opDir) } : null;
}

export function listOps(dir) {
  const root = join(dir, "operations");
  if (!existsSync(root)) return [];
  return readdirSync(root).map((id) => readOp(dir, id)).filter(Boolean)
    .sort((a, b) => String(a.op.createdAt ?? "").localeCompare(String(b.op.createdAt ?? "")));
}

export function resolveOp(dir, ref) {
  const root = join(dir, "operations");
  if (!existsSync(root)) return null;
  const ids = readdirSync(root).filter((id) => id === ref || id.endsWith(ref));
  if (ids.length !== 1) throw new Error(ids.length ? `ambiguous op ref ${ref}: ${ids.join(", ")}` : `no op matches ${ref}`);
  return readOp(dir, ids[0]);
}

function payload(t) { return t.row?.providerState?.providerPayload ?? {}; }

export function summarizeOp(entry) {
  const turns = entry.turns;
  const sum = (f) => turns.reduce((n, t) => n + (f(t) ?? 0), 0);
  const ttfts = turns.map((t) => payload(t).ttftMs).filter((v) => typeof v === "number");
  return {
    op: entry.id.slice(-12),
    type: entry.op.type,
    status: entry.op.status,
    run: turns.find((t) => t.trace)?.trace?.runId ?? "",
    model: turns.map((t) => payload(t).model).find(Boolean) ?? "",
    turns: turns.length,
    traced: turns.filter((t) => t.trace).length,
    tokIn: sum((t) => payload(t).usageInputTokens),
    tokOut: sum((t) => payload(t).usageOutputTokens),
    cached: sum((t) => payload(t).cacheReadTokens ?? payload(t).promptCachedTokens),
    ttftAvgMs: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
    modelMs: sum((t) => t.row?.modelMs),
    tools: sum((t) => t.row?.toolCallSummary?.length),
    overWindow: turns.filter((t) => payload(t).promptOverWindow).length,
    created: String(entry.op.createdAt ?? "").slice(0, 19),
  };
}

export function turnRows(entry) {
  return entry.turns.map((t) => {
    const p = payload(t);
    const r = t.trace?.response;
    return {
      turn: t.idx,
      stop: p.stopReason ?? "",
      end: t.row?.terminalReason ?? "",
      tokIn: p.usageInputTokens ?? "",
      cached: p.cacheReadTokens ?? p.promptCachedTokens ?? "",
      tokOut: p.usageOutputTokens ?? "",
      ttftMs: p.ttftMs ?? "",
      modelMs: t.row?.modelMs ?? "",
      tools: (t.row?.toolCallSummary ?? []).map((c) => `${c.tool}:${c.resultStatus}`).join(" "),
      thinkChars: r ? r.thinking.length : "",
      textChars: r ? r.text.length : "",
      promptTools: t.trace ? t.trace.request.tools.length : "",
      over: p.promptOverWindow ? "YES" : "",
    };
  });
}

const head = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more chars]` : s);

export function renderTurn(t, { prompt = false } = {}) {
  const out = [];
  const tr = t.trace;
  if (!tr) return `turn ${t.idx}: no trace artifact (tracing off, or an adapter that does not trace yet)`;
  out.push(`turn ${t.idx}  run=${tr.runId}  model=${tr.model}  ${tr.baseURL ?? ""}`);
  out.push(`  timing: ${tr.timing.startedAt} → ${tr.timing.endedAt}  modelMs=${tr.timing.modelMs}  ttftMs=${tr.response.ttftMs ?? "-"}`);
  const rq = tr.request;
  out.push(`  request: system ${rq.systemPrompt.length} chars, ${rq.messages.length} messages [${rq.messages.map((m) => m.role).join(",")}], ${rq.tools.length} tools` +
    ` [${rq.tools.map((x) => x.name).join(",")}]` +
    `${rq.temperature !== undefined ? ` temperature=${rq.temperature}` : ""}${rq.maxTokens !== undefined ? ` max_tokens=${rq.maxTokens}` : ""}` +
    `${rq.reasoningEffort ? ` reasoning_effort=${rq.reasoningEffort}` : ""}${rq.toolChoice ? ` tool_choice=${JSON.stringify(rq.toolChoice)}` : ""}`);
  const rs = tr.response;
  out.push(`  response: stop=${rs.stopReason ?? "-"} usage=${rs.usage ? `${rs.usage.promptTokens ?? "-"} in / ${rs.usage.completionTokens ?? "-"} out / ${rs.usage.cachedTokens ?? "-"} cached` : "none"}` +
    `${rs.promptOverWindow ? " PROMPT-OVER-WINDOW" : ""}${rs.stoppedByGuard ? ` guard=${rs.stoppedByGuard}` : ""}${rs.error ? ` error=${rs.error.code}: ${rs.error.message}` : ""}`);
  if (rs.thinking) out.push(`  thinking (${rs.thinking.length} chars):\n${indent(head(rs.thinking, 1200))}`);
  if (rs.toolCalls.length) out.push(`  tool calls:\n${rs.toolCalls.map((c) => `    ${c.name}(${head(c.arguments, 300)})`).join("\n")}`);
  if (rs.rawText !== rs.text) out.push(`  raw text (${rs.rawText.length} chars, before extraction):\n${indent(head(rs.rawText, 1500))}`);
  out.push(`  text (${rs.text.length} chars):\n${indent(head(rs.text, 1500))}`);
  if (prompt) {
    out.push(`  --- system prompt ---\n${indent(rq.systemPrompt)}`);
    out.push(`  --- messages ---\n${indent(JSON.stringify(rq.messages, null, 1))}`);
    out.push(`  --- tools ---\n${indent(JSON.stringify(rq.tools, null, 1))}`);
  }
  return out.join("\n");
}

function indent(s) { return s.split("\n").map((l) => `    ${l}`).join("\n"); }

/** Where two ops' first turns stop agreeing: the prefix a runtime could have cached. */
export function firstDivergence(a, b) {
  const ta = a.turns.find((t) => t.trace)?.trace, tb = b.turns.find((t) => t.trace)?.trace;
  if (!ta || !tb) return "one of the ops has no trace";
  const sa = ta.request.systemPrompt, sb = tb.request.systemPrompt;
  let i = 0; while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  const toolsA = ta.request.tools.map((t) => t.name), toolsB = tb.request.tools.map((t) => t.name);
  const sameTools = toolsA.join(",") === toolsB.join(",");
  return `system prompt: ${i === sa.length && i === sb.length ? "identical" : `diverges at char ${i} of ${sa.length}/${sb.length}`}; ` +
    `tools: ${sameTools ? `identical (${toolsA.length})` : `differ — only in A: [${toolsA.filter((x) => !toolsB.includes(x)).join(",")}] only in B: [${toolsB.filter((x) => !toolsA.includes(x)).join(",")}]`}`;
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const dir = dataDir(argv);
  if (cmd === "list") {
    const run = flag(argv, "--run");
    const limit = Number(flag(argv, "--limit") ?? 50);
    const rows = listOps(dir).map(summarizeOp).filter((r) => !run || r.run === run).slice(-limit);
    console.table(rows);
    return rows;
  }
  if (cmd === "show") {
    const entry = resolveOp(dir, rest[0]);
    if (!entry) throw new Error("no such op");
    const turn = flag(argv, "--turn");
    if (argv.includes("--json")) { console.log(JSON.stringify(turn !== undefined ? entry.turns[Number(turn)] : entry, null, 1)); return entry; }
    console.log(`${entry.id}  type=${entry.op.type} status=${entry.op.status} created=${entry.op.createdAt}`);
    if (turn === undefined) { console.table(turnRows(entry)); return entry; }
    const t = entry.turns.find((x) => x.idx === Number(turn));
    if (!t) throw new Error(`no turn ${turn}`);
    console.log(renderTurn(t, { prompt: argv.includes("--prompt") }));
    return t;
  }
  if (cmd === "diff") {
    const a = resolveOp(dir, rest[0]), b = resolveOp(dir, rest[1]);
    if (!a || !b) throw new Error("need two ops");
    console.log(`A ${a.id}\nB ${b.id}`);
    console.table([{ which: "A", ...summarizeOp(a) }, { which: "B", ...summarizeOp(b) }]);
    console.log(firstDivergence(a, b));
    return { a: summarizeOp(a), b: summarizeOp(b), divergence: firstDivergence(a, b) };
  }
  console.log("usage: lax-trace list [--data DIR] [--run RUNID] [--limit N] | show <opId> [--turn N] [--prompt] [--json] | diff <opA> <opB>");
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}

#!/usr/bin/env -S npx tsx
/**
 * Op-outcomes battery — the harness eval. Every run of every case gets its own
 * isolated LAX server (isolated.mjs) and a fresh copy of the fixture workspace,
 * drives the case's sessions/turns through /api/chat with real tool execution
 * against the loopback fixture server, then grades on evidence (checks.mjs):
 * files, test runs, requests the fixture server received, tools used.
 *
 * Per run it also reads the isolated op store for what the harness did along
 * the way — rounds, model/tool time, tokens, cache, nudges, compaction — so a
 * harness change is judged on pass rate AND cost, not pass rate alone.
 *
 * Needs a current build (`npm run build`); it refuses a dist older than src/.
 *
 * Run:  npx tsx eval/op-outcomes/run.mjs --provider muse --repeat 3
 *       npx tsx eval/op-outcomes/run.mjs --provider all --only coding
 *       npx tsx eval/op-outcomes/run.mjs --provider grok --only bugfix-with-followup --keep
 *
 * Your running LAX app and ~/.lax are untouched: each server has its own data
 * dir, workspace and port. Provider logins are read in place, never copied.
 * Headless browser; nothing opens on screen.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer, DEPLOY_TOKEN } from "./fixtures/server.mjs";
import { assertDistMatchesSource, startIsolatedServer } from "./isolated.mjs";
import { SETUP, closeChecks, runCheck, snapshotBefore } from "./checks.mjs";
import { readOps, waitForIdleOps } from "./op-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const PROVIDER = opt("--provider") ?? "all";
const ONLY = opt("--only");
const REPEAT = Math.max(1, Number(opt("--repeat")) || 1);
const TURN_TIMEOUT_MS = Number(opt("--timeout")) || 900_000;
const KEEP = args.includes("--keep");

const providers = JSON.parse(readFileSync(join(HERE, "providers.json"), "utf8")).providers
  .filter((p) => PROVIDER === "all" || p.label === PROVIDER);
if (providers.length === 0) { console.error(`no provider "${PROVIDER}" in providers.json`); process.exit(2); }

const cases = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8")).cases
  .filter((c) => !ONLY || c.id === ONLY || c.category === ONLY);
if (cases.length === 0) { console.error(`no case or category matches "${ONLY}"`); process.exit(2); }

/** One chat turn over the SSE endpoint. */
async function chatTurn(server, sessionId, message, timeoutMs) {
  const reply = { text: "", tools: [], error: "" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: "POST", headers: server.headers, body: JSON.stringify({ message, sessionId }), signal: ac.signal,
    });
    if (!res.ok) { reply.error = `HTTP ${res.status}`; return reply; }
    let buf = "";
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === "stream") {
          if (typeof ev.delta === "string") reply.text += ev.delta;
          else if (typeof ev.text === "string") reply.text = ev.text;
        } else if (ev.type === "tool_start" && ev.toolName) reply.tools.push(ev.toolName);
        else if (ev.type === "error" && ev.message) reply.error = ev.message;
      }
    }
  } catch (e) {
    reply.error = e.name === "AbortError" ? `turn timeout ${timeoutMs}ms` : e.message;
  } finally {
    clearTimeout(timer);
  }
  return reply;
}

/** What the harness did for the whole run — the isolated store holds only this
 *  case's ops, including any background ops a chat turn spawned. */
function collectMetrics(dataDir) {
  const m = { ops: 0, rounds: 0, modelMs: 0, toolMs: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
    nudges: 0, compactedRounds: 0, errors: 0, chatModels: new Set() };
  for (const { dir, op } of readOps(dataDir)) {
    m.ops++;
    const turnsDir = join(dir, "op-turns");
    for (const f of existsSync(turnsDir) ? readdirSync(turnsDir) : []) {
      let turn;
      try { turn = JSON.parse(readFileSync(join(turnsDir, f), "utf8")).turn; } catch { continue; }
      if (!turn) continue;
      const p = turn.providerState?.providerPayload ?? {};
      m.rounds++;
      m.modelMs += turn.modelMs ?? 0;
      m.toolMs += turn.toolDispatchMs ?? 0;
      m.inputTokens += p.usageInputTokens ?? p.usagePromptTokens ?? 0;
      m.outputTokens += p.usageOutputTokens ?? p.usageCompletionTokens ?? 0;
      m.cacheRead += p.cacheReadTokens ?? 0;
      m.cacheWrite += p.cacheCreateTokens ?? 0;
      if (turn.providerState?.viewCompacted) m.compactedRounds++;
      if (turn.terminalReason === "error") m.errors++;
      if (p.model && op.type === "chat_turn") m.chatModels.add(p.model);
    }
    const msgs = join(dir, "op-messages.jsonl");
    if (existsSync(msgs)) m.nudges += (readFileSync(msgs, "utf8").match(/"messageId":"nudge-/g) ?? []).length;
  }
  return { ...m, chatModels: [...m.chatModels] };
}

async function bootServer(provider, fixture, caseDef) {
  // Every turn and the idle wait can each take the case timeout.
  const turns = (caseDef.sessions ?? []).reduce((n, s) => n + (s.turns?.length ?? 0), 0);
  const maxLifetimeMs = (turns + 1) * (caseDef.timeoutMs ?? TURN_TIMEOUT_MS) + 15 * 60_000;
  const opts = { repoRoot: REPO_ROOT, provider: provider.provider, model: provider.model, fixturePort: fixture.port, maxLifetimeMs };
  try {
    return await startIsolatedServer(opts);
  } catch (first) {
    console.log(`  [${provider.label}] server boot failed, retrying once: ${first.message.split("\n")[0]}`);
    return await startIsolatedServer(opts);
  }
}

async function runCase(provider, caseDef, fixture) {
  const started = Date.now();
  const fill = (s) => String(s).replaceAll("{{BASE}}", fixture.baseUrl).replaceAll("{{DEPLOY_TOKEN}}", DEPLOY_TOKEN);
  const result = { id: caseDef.id, category: caseDef.category, pass: false, checks: [], replies: [], toolsUsed: [], errors: [] };
  let server;
  try {
    server = await bootServer(provider, fixture, caseDef);
  } catch (e) {
    result.errors.push(`server boot: ${e.message.split("\n")[0]}`);
    result.logTail = e.message;
    result.secs = Math.round((Date.now() - started) / 1000);
    return result;
  }
  result.workspace = server.workspace;
  try {
    const fixtureMark = fixture.requests.length;
    for (const step of caseDef.setup ?? []) await SETUP[step]({ server, workspace: server.workspace, deployToken: DEPLOY_TOKEN });
    const before = snapshotBefore(caseDef, { workspace: server.workspace });
    for (const [s, session] of caseDef.sessions.entries()) {
      const sessionId = `eval-${caseDef.id}-${s}-${Math.random().toString(36).slice(2, 8)}`;
      for (const turn of session.turns) {
        const reply = await chatTurn(server, sessionId, fill(turn), caseDef.timeoutMs ?? TURN_TIMEOUT_MS);
        result.replies.push(reply.text.trim());
        result.toolsUsed.push(...reply.tools);
        if (reply.error) result.errors.push(reply.error);
      }
      // Memory writes run after the reply streams; let them land before the next session reads.
      if (s < caseDef.sessions.length - 1) await new Promise((r) => setTimeout(r, 8_000));
    }
    // Before anything is graded: did the server outlive the run? A process
    // that killed itself mid-turn leaves missing files and unfinished ops that
    // look exactly like a model giving up — scored as model failures for
    // months (the probe self-destruct's 10-minute cap, found 2026-09-16).
    const died = server.exitedOnItsOwn();
    if (died) {
      result.harnessError = `server exited mid-run (code ${died.code}, signal ${died.signal}) — not a model result`;
      result.errors.push(result.harnessError);
      result.logTail = server.logTail();
      return result;
    }
    // A chat turn can hand work to background ops (agent_spawn, op_submit_async)
    // and end while they run. The user eventually gets that result, so grading
    // waits for every op to leave pending/running — or the case timeout.
    const stillRunning = await waitForIdleOps(server.dataDir, caseDef.timeoutMs ?? TURN_TIMEOUT_MS);
    if (stillRunning) result.errors.push(stillRunning);
    result.metrics = collectMetrics(server.dataDir);
    if (result.metrics.chatModels.length > 0 && !result.metrics.chatModels.every((m) => m === provider.model)) {
      result.checks.push({ type: "model", ok: false, detail: `chat ran on ${result.metrics.chatModels.join(", ")}, expected ${provider.model}` });
    }
    const ctx = { workspace: server.workspace, fixture, fixtureMark, replies: result.replies, toolsUsed: result.toolsUsed,
      before, dataDir: server.dataDir, fill };
    for (const check of caseDef.checks) result.checks.push({ type: check.type, ...(await runCheck(check, ctx)) });
    result.pass = result.checks.every((c) => c.ok);
  } catch (e) {
    result.errors.push(e.message);
    result.logTail = server.logTail();
  } finally {
    result.secs = Math.round((Date.now() - started) / 1000);
    await server.stop();
    if (result.pass && !KEEP) { server.cleanup(); delete result.workspace; }
  }
  return result;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function summarize(batch) {
  console.log(`\n${batch.label} (${batch.provider}/${batch.model})`);
  const byCase = new Map();
  for (const r of batch.runs) byCase.set(r.id, [...(byCase.get(r.id) ?? []), r]);
  for (const [id, runs] of byCase) {
    const pass = runs.filter((r) => r.pass).length;
    const med = (k) => median(runs.map((r) => r.metrics?.[k] ?? 0));
    console.log(`  ${id.padEnd(34)} ${pass}/${runs.length} pass  ${String(median(runs.map((r) => r.secs))).padStart(4)}s  rounds ${med("rounds")}  nudges ${med("nudges")}  in ${med("inputTokens")}  out ${med("outputTokens")}`);
  }
  const total = batch.runs.length, passed = batch.runs.filter((r) => r.pass).length;
  console.log(`  ${"TOTAL".padEnd(34)} ${passed}/${total} pass (${Math.round((100 * passed) / total)}%)`);
}

assertDistMatchesSource(REPO_ROOT);
const fixture = await startFixtureServer();
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "results");
mkdirSync(outDir, { recursive: true });
// Provider label + pid: two batches started in the same second (muse and grok
// run in parallel) otherwise overwrite each other's results file.
const outPath = join(outDir, `run-${stamp}-${PROVIDER}-${process.pid}.json`);
const report = { when: stamp, gitHead: null, repeat: REPEAT, batches: [] };
try { report.gitHead = (await import("node:child_process")).execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT }).toString().trim(); } catch { /* not a checkout */ }

console.log(`op-outcomes: ${cases.length} case(s) × ${REPEAT} × ${providers.map((p) => p.label).join(", ")} @ ${report.gitHead ?? "?"}`);
try {
  for (const provider of providers) {
    const batch = { ...provider, runs: [] };
    report.batches.push(batch);
    for (const caseDef of cases) {
      for (let i = 0; i < REPEAT; i++) {
        const r = await runCase(provider, caseDef, fixture);
        batch.runs.push(r);
        const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.type}: ${c.detail}`);
        console.log(`  [${provider.label}] ${r.harnessError ? "HARNESS-ERROR" : r.pass ? "PASS" : "FAIL"} ${caseDef.id}${REPEAT > 1 ? ` #${i + 1}` : ""} ${r.secs}s${failed.length ? `  — ${failed.join("; ")}` : ""}${r.errors.length ? `  errors: ${r.errors.join(" | ").slice(0, 200)}` : ""}${r.workspace ? `  kept: ${r.workspace}` : ""}`);
        writeFileSync(outPath, JSON.stringify(report, null, 2));
      }
    }
    summarize(batch);
  }
} finally {
  await fixture.close();
  await closeChecks();
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nresults → ${outPath}`);
}
// Importing seedProbeProvider loads LAX modules that start config/manifest
// watchers, which keep the event loop alive forever after the batch is done —
// every finished batch sat in memory and a `run.mjs && run.mjs` queue never
// advanced. The results are written; end the process.
process.exit(0);

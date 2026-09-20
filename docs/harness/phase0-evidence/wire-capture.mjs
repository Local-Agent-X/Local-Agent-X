// Boot an ISOLATED LAX server (temp data dir, temp workspace; never ~/.lax) whose Ollama URL points at the
// logging proxy, drive a short tool-using op, and record what the adapter sent per request plus what Ollama
// re-prefilled per turn (server.log print_timing lines). Run with: npx tsx wire-capture.mjs [model]
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";

const REPO = "C:/Users/peter/local-agent-x";
const MODEL = process.argv[2] ?? "qwen3.6:27b";
const PROXY_PORT = 11435;
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const WIRE = `${HERE}wire.jsonl`;
const SERVER_LOG = "C:/Users/peter/AppData/Local/Ollama/server.log";
const OUT = `${HERE}wire-capture.${MODEL.replace(/[^a-z0-9.]/gi, "_")}.json`;

process.env.LAX_OLLAMA_URL = `http://127.0.0.1:${PROXY_PORT}`;
const { startIsolatedServer, assertDistMatchesSource } = await import(`file:///${REPO}/eval/op-outcomes/isolated.mjs`);
const { waitForIdleOps, readOps } = await import(`file:///${REPO}/eval/op-outcomes/op-store.mjs`);

assertDistMatchesSource(REPO);
if (existsSync(WIRE)) writeFileSync(WIRE, "");
const logMark = existsSync(SERVER_LOG) ? statSync(SERVER_LOG).size : 0;

const proxy = spawn(process.execPath, [`${HERE}wire-proxy.mjs`, String(PROXY_PORT)], { stdio: ["ignore", "inherit", "inherit"] });
await new Promise((r) => setTimeout(r, 800));

async function driveChat(server, message, sessionId, timeoutMs) {
  let text = "", err = "", events = 0;
  const tools = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${server.baseUrl}/api/chat`, { method: "POST", headers: server.headers, body: JSON.stringify({ message, sessionId }), signal: ac.signal });
    if (!res.ok) err = `HTTP ${res.status}`;
    else {
      let buf = "";
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let ev; try { ev = JSON.parse(payload); } catch { continue; }
          events++;
          if (ev.type === "stream") { if (typeof ev.delta === "string") text += ev.delta; else if (typeof ev.text === "string") text = ev.text; }
          else if (ev.type === "tool_call" || ev.type === "tool_start") tools.push(ev.name ?? ev.tool ?? "?");
          else if (ev.type === "error") err = String(ev.message ?? ev.error ?? "error");
        }
      }
    }
  } catch (e) { err = err || String(e?.message ?? e); }
  finally { clearTimeout(timer); }
  return { text: text.slice(0, 500), err, tools, events, secs: Math.round((Date.now() - t0) / 1000) };
}

const server = await startIsolatedServer({ repoRoot: REPO, provider: "local", model: MODEL, fixturePort: undefined, maxLifetimeMs: 20 * 60_000 });
const result = { model: MODEL, turns: [] };
try {
  const sessionId = `wire-${Date.now()}`;
  for (const msg of [
    "List the projects in my workspace and tell me in one line what each one is.",
    "Read the README of the nav-app project and summarize it in two sentences.",
    "Which of those projects has a test folder? Answer from what you already saw.",
  ]) {
    const t = await driveChat(server, msg, sessionId, 6 * 60_000);
    result.turns.push({ msg, ...t });
    console.log(`\n>>> ${msg}\n<<< [${t.secs}s, tools=${t.tools.join(",")}] ${t.text.slice(0, 200)}${t.err ? `\nERR ${t.err}` : ""}`);
    await waitForIdleOps(server.dataDir, 120_000);
  }
  result.ops = [...readOps(server.dataDir)].map(({ op }) => ({ id: op.id, kind: op.kind, status: op.status, turns: op.turnCount ?? op.turns?.length ?? null }));
  // Per-turn usage as the harness recorded it (the data dir is deleted on stop).
  const { readdirSync: rd, existsSync: ex } = await import("node:fs");
  const { join } = await import("node:path");
  result.turnUsage = [];
  for (const { dir, op } of readOps(server.dataDir)) {
    const turnsDir = join(dir, "op-turns");
    for (const f of ex(turnsDir) ? rd(turnsDir).sort() : []) {
      try {
        const t = JSON.parse(readFileSync(join(turnsDir, f), "utf8")).turn;
        const p = t?.providerState?.providerPayload ?? {};
        result.turnUsage.push({ op: op.id.slice(-8), turn: f, model: p.model, modelMs: t?.modelMs, ttftMs: p.ttftMs, in: p.usageInputTokens, out: p.usageOutputTokens, cached: p.promptCachedTokens, overWindow: p.promptOverWindow, stop: p.stopReason });
      } catch {}
    }
  }
} finally {
  result.serverLogTail = server.logTail().split("\n").slice(-40);
  await server.stop();
  proxy.kill();
}

const wire = readFileSync(WIRE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
result.requests = wire.filter((w) => w.model).map((w) => ({ at: w.at.slice(11, 23), path: w.path, model: w.model, stream: w.stream, think: w.think, format: w.format, keep_alive: w.keep_alive, options: w.options, max_tokens: w.max_tokens, temperature: w.temperature, top_p: w.top_p, stop: w.stop, reasoning_effort: w.reasoning_effort, tools: w.tools, tools_json_chars: w.tools_json_chars, messages: w.messages, roles: w.roles?.join(","), system_count: w.system_count, system_chars: w.system_chars, total_chars: w.total_chars, other_keys: w.other_keys, tool_names: w.tool_names }));
result.responses = wire.filter((w) => w.response_for).map((w) => ({ at: w.at.slice(11, 23), path: w.response_for, status: w.status, ms: w.ms, bytes: w.bytes }));
const firstReq = result.requests[0];
result.system_head = wire.find((w) => w.model)?.system_head;
result.system_tail = wire.find((w) => w.model)?.system_tail;
if (existsSync(SERVER_LOG)) {
  const fresh = readFileSync(SERVER_LOG, "utf8").slice(logMark);
  result.ollama_prompt_evals = fresh.split("\n").filter((l) => /prompt eval time|truncating|n_ctx_slot|load_model|cached n_tokens/.test(l)).map((l) => l.replace(/\r$/, "").replace(/^.*?\|\s*/, "").slice(0, 160));
}
writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log(`\nrequests: ${result.requests.length}; wrote ${OUT}`);
console.table(result.requests.map((r) => ({ at: r.at, path: r.path, think: r.think, num_ctx: r.options?.num_ctx, keep_alive: r.keep_alive, tools: r.tools, msgs: r.messages, sys_chars: r.system_chars, total_chars: r.total_chars })));
console.log(result.ollama_prompt_evals?.join("\n"));

process.exit(0);

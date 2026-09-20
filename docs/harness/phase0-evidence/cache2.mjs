// Follow-ups to probes.mjs core: cache-slot count, per-slot context at 65536, /v1 reasoning control, 262k spill.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
const BASE = "http://localhost:11434";
const MODEL = process.argv[2] ?? "qwen3.6:27b";
const CTX = 65536;
const OUT = new URL(`./probe-results.cache2.${MODEL.replace(/[^a-z0-9.]/gi, "_")}.json`, import.meta.url);
const SERVER_LOG = "C:/Users/peter/AppData/Local/Ollama/server.log";
const results = [];
function record(name, data) { results.push({ name, at: new Date().toISOString(), ...data }); console.log(`\n### ${name}`); console.log(JSON.stringify(data, null, 1).slice(0, 3500)); writeFileSync(OUT, JSON.stringify(results, null, 1)); }
async function post(path, body, timeoutMs = 600000) { const t0 = Date.now(); const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text, ms: Date.now() - t0 }; }
async function get(path) { const r = await fetch(BASE + path, { signal: AbortSignal.timeout(30000) }); return r.json(); }
async function ps() { const j = await get("/api/ps"); return (j.models ?? []).filter((m) => !m.name.startsWith("mxbai")).map((m) => ({ name: m.name, size_gb: +(m.size / 2 ** 30).toFixed(2), vram_gb: +(m.size_vram / 2 ** 30).toFixed(2), gpu_pct: m.size ? Math.round((100 * m.size_vram) / m.size) : null, ctx: m.context_length, expires_in_min: m.expires_at ? Math.round((new Date(m.expires_at) - Date.now()) / 60000) : null })); }
const WORDS = "the quick brown fox jumps over the lazy dog while seven wizards quietly judge the vexing plan and a small harness carries the model through every ordinary task without fuss".split(" ");
function filler(chars, seed = 0) { let s = ""; let i = seed; while (s.length < chars) { s += WORDS[i % WORDS.length] + (i % 17 === 16 ? ".\n" : " "); i++; } return s; }
function stats(j) { if (!j) return null; return { done_reason: j.done_reason, load_ms: Math.round((j.load_duration ?? 0) / 1e6), prompt_eval_count: j.prompt_eval_count, prompt_eval_ms: Math.round((j.prompt_eval_duration ?? 0) / 1e6), eval_count: j.eval_count, eval_ms: Math.round((j.eval_duration ?? 0) / 1e6), decode_tps: j.eval_duration ? Math.round((10 * j.eval_count) / (j.eval_duration / 1e9)) / 10 : null, thinking_chars: j.message?.thinking?.length ?? 0, content: (j.message?.content ?? "").slice(0, 200) }; }
async function chat(body, timeoutMs) { const r = await post("/api/chat", { stream: false, ...body }, timeoutMs); return { status: r.status, ms: r.ms, error: r.json?.error, ...stats(r.json) }; }
async function step(name, fn) { try { record(name, await fn()); } catch (e) { record(name, { error: String(e?.message ?? e) }); } }
function logTail(pattern, n = 400) { if (!existsSync(SERVER_LOG)) return ["(no server.log)"]; return readFileSync(SERVER_LOG, "utf8").split("\n").slice(-n).filter((l) => pattern.test(l)).map((l) => l.slice(0, 200)); }
const OK = [{ role: "user", content: "Reply with the single word OK." }];

await step("templates as exposed by /api/show", async () => { const a = (await post("/api/show", { model: MODEL })).json ?? {}; const b = (await post("/api/show", { model: "qwen3:8b" })).json ?? {}; return { [MODEL]: JSON.stringify(a.template), "qwen3:8b_head": (b.template ?? "").slice(0, 600), "qwen3:8b_has_tool_call_tag": /tool_call/.test(b.template ?? ""), "qwen3:8b_has_think": /think/.test(b.template ?? "") }; });
await step(`load @${CTX}`, async () => ({ chat: await chat({ model: MODEL, messages: OK, think: false, options: { num_ctx: CTX } }), ps: await ps() }));
await step("server.log: slots / parallel / n_ctx at load", () => ({ lines: logTail(/n_parallel|n_ctx|slot|n_seq_max|n_batch|checkpoints|num_parallel|parallel/i, 300).slice(-25) }));

// Per-slot context: a ~40k-token prompt into a 65536 window. If the window is split across 2 slots, this truncates at ~32k.
const big = "The secret word is PELICAN. " + filler(200000);
await step("40k-token prompt @65536: truncated?", async () => { const c = await chat({ model: MODEL, messages: [{ role: "system", content: big }, { role: "user", content: "What is the secret word stated at the very start of the system message? Answer with one word." }], think: false, options: { num_ctx: CTX, num_predict: 10 } }); return { ...c, server_log_lines: logTail(/truncat/i, 80).slice(-3) }; });

// Cache slots: alternate two different 6k systems. Two slots -> the second A call hits; one slot -> every call misses.
const A = filler(24000, 0), B = filler(24000, 5);
const probe = async (system, user) => { const c = await chat({ model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }], think: false, options: { num_ctx: CTX, num_predict: 4 } }); return { prompt_eval_count: c.prompt_eval_count, prompt_eval_ms: c.prompt_eval_ms }; };
await step("slots: A", () => probe(A, "Reply OK."));
await step("slots: B", () => probe(B, "Reply OK."));
await step("slots: A again (hit => 2+ slots)", () => probe(A, "Reply OK."));
await step("slots: B again", () => probe(B, "Reply OK."));

// What breaks the prefix cache, measured from a known state (A is resident after the step above).
const ts = () => `Now: ${new Date().toISOString()} session=${Math.random().toString(36).slice(2)}\n`;
await step("cache: A + same user (baseline hit)", () => probe(A, "Reply OK."));
await step("cache: A + NEW user message", () => probe(A, "Reply with the word DONE."));
await step("cache: A + same user (re-hit)", () => probe(A, "Reply OK."));
await step("cache: A with timestamp APPENDED", () => probe(A + "\n" + ts(), "Reply OK."));
await step("cache: A restored", () => probe(A, "Reply OK."));
await step("cache: A with timestamp PREPENDED", () => probe(ts() + A, "Reply OK."));
await step("cache: A restored again", () => probe(A, "Reply OK."));
await step("cache: A + 3-turn history", () => probe(A, "Reply OK."));
await step("cache: A + history grown by one turn", async () => { const c = await chat({ model: MODEL, messages: [{ role: "system", content: A }, { role: "user", content: "Reply OK." }, { role: "assistant", content: "OK" }, { role: "user", content: "Again." }], think: false, options: { num_ctx: CTX, num_predict: 4 } }); return { prompt_eval_count: c.prompt_eval_count, prompt_eval_ms: c.prompt_eval_ms }; });
await step("cache: same history, tools ADDED to the request", async () => { const c = await chat({ model: MODEL, messages: [{ role: "system", content: A }, { role: "user", content: "Reply OK." }, { role: "assistant", content: "OK" }, { role: "user", content: "Again." }], tools: [{ type: "function", function: { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }], think: false, options: { num_ctx: CTX, num_predict: 4 } }); return { prompt_eval_count: c.prompt_eval_count, prompt_eval_ms: c.prompt_eval_ms, note: "if tools render before the system prompt in the template, this is a full re-prefill" }; });

// /v1 reasoning control and stop with reasoning off.
await step("/v1 reasoning_effort none", async () => { const r = await post("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "What is 17*23? Answer with the number only." }], max_tokens: 50, reasoning_effort: "none" }); const c = r.json?.choices?.[0]; return { status: r.status, error: r.json?.error, finish_reason: c?.finish_reason, content: c?.message?.content, reasoning_len: (c?.message?.reasoning ?? "").length, usage: r.json?.usage }; });
await step("/v1 stop with reasoning off", async () => { const r = await post("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "Write exactly this and nothing else: alpha STOPHERE beta" }], stop: ["STOPHERE"], max_tokens: 60, reasoning_effort: "none" }); const c = r.json?.choices?.[0]; return { status: r.status, finish_reason: c?.finish_reason, content: c?.message?.content, reasoning_len: (c?.message?.reasoning ?? "").length }; });
await step("/v1 think:false (non-standard field)", async () => { const r = await post("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "What is 17*23? Answer with the number only." }], max_tokens: 50, think: false }); const c = r.json?.choices?.[0]; return { status: r.status, finish_reason: c?.finish_reason, content: c?.message?.content, reasoning_len: (c?.message?.reasoning ?? "").length }; });
await step("/v1 response_format json_schema + reasoning none", async () => { const r = await post("/v1/chat/completions", { model: MODEL, messages: [{ role: "user", content: "Capital of France as JSON." }], max_tokens: 60, reasoning_effort: "none", response_format: { type: "json_schema", json_schema: { name: "a", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } } }); const c = r.json?.choices?.[0]; return { status: r.status, error: r.json?.error, finish_reason: c?.finish_reason, content: c?.message?.content }; });

// 262k: does it fit, or spill to CPU?
await step("num_ctx 262144 load (spill?)", async () => ({ chat: await chat({ model: MODEL, messages: OK, think: false, options: { num_ctx: 262144, num_predict: 6 } }, 900000), ps: await ps() }));
await step("decode @262144", () => chat({ model: MODEL, messages: [{ role: "user", content: "Count from 1 to 40, one number per line." }], think: false, options: { num_ctx: 262144, num_predict: 80 } }, 900000));
await step(`restore @${CTX}`, async () => ({ chat: await chat({ model: MODEL, messages: OK, think: false, options: { num_ctx: CTX } }), ps: await ps() }));
console.log(`\nwrote ${OUT.pathname}`);

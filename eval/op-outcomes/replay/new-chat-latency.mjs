#!/usr/bin/env node
// New-chat first-token latency on the local runtime, with and without the
// new-chat pre-warm (POST /api/chat/prewarm). The op-outcomes rig cannot see
// this: every case boots its own server, so no case ever opens a second chat.
//
// One isolated server; per trial: a two-message chat (so the runtime's cache
// ends far past the head), then a new chat's first message, either cold or
// after a pre-warm and a pause standing in for the user typing. Reads the new
// chat's first round from its op record: time to first token, prompt tokens
// served from cache.
//
//   node eval/op-outcomes/replay/new-chat-latency.mjs [--model qwen3.6:27b] [--trials 3] [--typing-ms 15000] [--paste-lines 250] [--extra-turns 0]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startIsolatedServer } from "../isolated.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const model = arg("model", "qwen3.6:27b");
const trials = Number(arg("trials", "3"));
const typingMs = Number(arg("typing-ms", "15000"));
// The old chat must end far past the head, as a real one does: a hybrid model restores
// its cache only near the end of the last prefill, so a two-line chat hides the cost.
const pasteLines = Number(arg("paste-lines", "250"));
// Ollama keeps several restore points from recent requests; a chat with many rounds pushes out
// the early ones near the head. Extra short turns after the paste stand in for a long chat.
const extraTurns = Number(arg("extra-turns", "0"));
const paste = Array.from({ length: pasteLines }, (_, i) => `Line ${i}: the ${["north", "south", "east", "west"][i % 4]} depot shipped ${(i * 37) % 500} crates on day ${i % 30}.`).join(String.fromCharCode(10));

async function turn(server, sessionId, message) {
  const res = await fetch(`${server.baseUrl}/api/chat`, {
    method: "POST", headers: server.headers, body: JSON.stringify({ message, sessionId }), signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  for await (const _ of res.body) { /* drain the SSE stream to the end of the turn */ }
}

function firstRound(dataDir, sessionId) {
  const opsDir = join(dataDir, "operations");
  for (const id of existsSync(opsDir) ? readdirSync(opsDir) : []) {
    const op = JSON.parse(readFileSync(join(opsDir, id, "operation.json"), "utf8"));
    if (op.sessionId !== sessionId || op.type !== "chat_turn") continue;
    const p = JSON.parse(readFileSync(join(opsDir, id, "op-turns", "0.json"), "utf8")).turn.providerState.providerPayload;
    return { ttftMs: p.ttftMs, cached: p.promptCachedTokens ?? 0, prompt: p.usageInputTokens ?? p.usagePromptTokens };
  }
  return null;
}

const server = await startIsolatedServer({ repoRoot, provider: "local", model });
const rows = [];
try {
  for (let t = 0; t < trials; t++) {
    for (const prewarm of [false, true]) {
      const tag = `t${t}-${prewarm ? "warm" : "cold"}`;
      await turn(server, `lat-${tag}-old`, "Reply with one short sentence: what is a haiku?");
      await turn(server, `lat-${tag}-old`, `Here is a shipping log. Reply with one short sentence: which depot appears first?${String.fromCharCode(10)}${paste}`);
      for (let k = 0; k < extraTurns; k++) await turn(server, `lat-${tag}-old`, `Reply with one word: the name of color number ${k + 1} in a rainbow.`);
      let prewarmStatus = "";
      if (prewarm) prewarmStatus = (await server.api("POST", "/api/chat/prewarm", {})).outcome;
      await new Promise((r) => setTimeout(r, typingMs));
      await turn(server, `lat-${tag}-new`, "Reply with one short sentence: what is a sonnet?");
      const r = firstRound(server.dataDir, `lat-${tag}-new`);
      rows.push({ trial: t, mode: prewarm ? `pre-warm (${prewarmStatus})` : "cold", ...r });
      console.log(JSON.stringify(rows.at(-1)));
    }
  }
} finally {
  await server.stop();
}
console.table(rows);
// Undici keep-alive sockets to the stopped server hold the event loop open; the rig
// (run.mjs) ends the same way.
process.exit(0);

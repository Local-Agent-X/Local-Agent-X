#!/usr/bin/env node
/**
 * Tool-discovery eval runner.
 *
 * For each case in cases.json: POST the user message to /api/chat, parse the
 * SSE stream, capture the FIRST tool the agent called, score against
 * `expected` and `mustNotCall`. Prints per-case pass/fail + final score.
 *
 * Run with: node eval/tool-discovery/run.mjs
 *
 * Requirements: server running on the port + token in ~/.lax/config.json.
 *
 * Design notes:
 *   - Fresh sessionId per case (prefix lax-eval-) so cases don't share
 *     turn-context cache or memory. The agent treats each case as a cold
 *     start, which is the right baseline for "did it pick the right tool."
 *   - We only inspect the first tool_call event. Multi-tool turns are
 *     fine — what we measure is the agent's first reach.
 *   - 60s per-case timeout. Long-running ones (build_app, agent_spawn)
 *     return tool_call long before they finish, so 60s is more than enough.
 *   - Cases run sequentially to avoid clobbering the same provider rate
 *     limit. If you want parallel, bump the concurrency below — but the
 *     scores will be noisier from rate-limited retries.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──
const CONFIG_PATH = join(homedir(), ".lax", "config.json");
if (!existsSync(CONFIG_PATH)) {
  console.error(`ERROR: ${CONFIG_PATH} not found. Start the server once to generate config.`);
  process.exit(2);
}
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const PORT = config.port || 7007;
const TOKEN = config.authToken;
if (!TOKEN) {
  console.error(`ERROR: no authToken in ${CONFIG_PATH}.`);
  process.exit(2);
}
const BASE = `http://127.0.0.1:${PORT}`;

// ── Health probe so we fail fast with a useful message ──
try {
  const h = await fetch(`${BASE}/api/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!h.ok) throw new Error(`/api/health → ${h.status}`);
} catch (e) {
  console.error(`ERROR: server unreachable at ${BASE}. Is it running?\n  ${e.message}`);
  process.exit(2);
}

// ── Cases ──
const cases = JSON.parse(readFileSync(join(__dirname, "cases.json"), "utf-8")).cases;
const ARG = process.argv[2];
const filtered = ARG ? cases.filter((c) => c.id.includes(ARG)) : cases;
if (filtered.length === 0) {
  console.error(`No cases match filter "${ARG}". Available IDs:`);
  for (const c of cases) console.error(`  ${c.id}`);
  process.exit(2);
}

// ── Per-case runner ──
async function runCase(c) {
  // Hit the dedicated /api/eval/run endpoint — it captures the first tool
  // server-side and tombstones the throwaway session before returning, so
  // nothing pollutes the user's sidebar. Returns a small JSON envelope.
  let firstTool = null;
  let allTools = [];
  let assistantText = "";
  let errorText = "";

  try {
    // Retry on 429 — bucket refills at 10/s (rateLimitMax=120 / refill=10),
    // so 12s sleep fully refills from drained.
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`${BASE}/api/eval/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: c.message, timeoutMs: 60_000 }),
      });
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 12_000));
    }

    if (!res.ok) {
      errorText = `HTTP ${res.status}`;
    } else {
      const data = await res.json();
      firstTool = data.firstTool || null;
      allTools = data.allTools || [];
      assistantText = data.assistantText || "";
      if (data.error) errorText = data.error;
    }
  } catch (e) {
    errorText = e.message;
  }

  // ── Score ──
  const expected = c.expected || [];
  const mustNotCall = c.mustNotCall || [];
  let pass = false;
  let reason = "";
  if (firstTool) {
    if (mustNotCall.includes(firstTool)) {
      pass = false;
      reason = `called ${firstTool} (in mustNotCall)`;
    } else if (expected.includes(firstTool)) {
      pass = true;
      reason = `called ${firstTool}`;
    } else {
      pass = false;
      reason = `called ${firstTool} (expected one of: ${expected.join(", ")})`;
    }
  } else {
    pass = false;
    reason = errorText
      ? `no tool call — error: ${errorText.slice(0, 80)}`
      : `no tool call — replied with text${assistantText ? `: "${assistantText.slice(0, 60)}..."` : ""}`;
  }

  return { id: c.id, pass, reason, firstTool, allTools };
}

// ── Main ──
console.log(`\n  Tool-discovery eval — ${filtered.length} cases against ${BASE}\n`);
const results = [];
const t0 = Date.now();
// Server has a rate limiter (config.rateLimitMax defaults to 120 with
// refill 10/s); a single chat turn fires multiple internal HTTP requests
// that share the bucket, so we space cases out by 2s to stay clear of
// 429s. Cheap defensive pause — 30 cases × 2s = +60s total, well worth it.
const INTER_CASE_DELAY_MS = 2000;
for (let i = 0; i < filtered.length; i++) {
  const c = filtered[i];
  process.stdout.write(`  [${String(i + 1).padStart(2)}/${filtered.length}] ${c.id.padEnd(28)} `);
  const r = await runCase(c);
  results.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.reason}`);
  if (i < filtered.length - 1) await new Promise((res) => setTimeout(res, INTER_CASE_DELAY_MS));
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const passed = results.filter((r) => r.pass).length;
const total = results.length;
const score = ((passed / total) * 100).toFixed(0);

console.log(`\n  ── Result ──`);
console.log(`  Passed: ${passed}/${total}  (${score}%)`);
console.log(`  Elapsed: ${elapsed}s`);
if (passed < total) {
  console.log(`\n  Failures:`);
  for (const r of results) if (!r.pass) console.log(`    ${r.id.padEnd(28)} ${r.reason}`);
}
console.log("");

process.exit(passed === total ? 0 : 1);

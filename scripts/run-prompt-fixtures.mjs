#!/usr/bin/env node
/**
 * Prompt regression runner. Sends each fixture under tests/prompt-fixtures/
 * through the live chat API, checks declared invariants, reports pass/fail.
 *
 * Usage: node scripts/run-prompt-fixtures.mjs
 * Env:
 *   LAX_URL   — default http://127.0.0.1:7007
 *   LAX_TOKEN — default read from ~/.lax/config.json
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const URL_BASE = process.env.LAX_URL || "http://127.0.0.1:7007";
const TOKEN = process.env.LAX_TOKEN || (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".lax", "config.json"), "utf-8"));
    return cfg.authToken || "";
  } catch { return ""; }
})();
if (!TOKEN) { console.error("[fixtures] No auth token found (LAX_TOKEN or ~/.lax/config.json)"); process.exit(2); }

const FIXTURES_DIR = resolve("tests", "prompt-fixtures");
if (!existsSync(FIXTURES_DIR)) { console.error(`[fixtures] ${FIXTURES_DIR} does not exist`); process.exit(2); }

function parseFixture(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      let v = kv[2].trim();
      if (/^\d+$/.test(v)) v = parseInt(v, 10);
      else if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      meta[kv[1]] = v;
    }
  }
  return { meta, body: m[2] };
}

async function runOne(name, fixture) {
  const sessionId = `fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  const timeoutMs = fixture.meta.max_duration_ms || 30000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  let rawText = "";
  let toolCalls = [];
  let completionTokens = 0;
  try {
    const res = await fetch(`${URL_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId, message: fixture.meta.message, attachments: [] }),
      signal: controller.signal,
    });
    if (!res.ok) { return { name, pass: false, reason: `HTTP ${res.status}`, duration: Date.now() - start }; }

    // SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === "stream" && ev.delta) rawText += ev.delta;
            else if (ev.type === "tool_start" && ev.toolName) toolCalls.push({ name: ev.toolName, args: ev.args || "" });
            else if (ev.type === "done") completionTokens = ev.usage?.completionTokens || 0;
          } catch {}
        }
      }
    }
  } catch (e) {
    return { name, pass: false, reason: `aborted/error: ${e.message}`, duration: Date.now() - start };
  } finally { clearTimeout(timer); }

  const reasons = [];
  const { meta } = fixture;
  if (meta.expect_tool_call) {
    if (!toolCalls.some(tc => tc.name === meta.expect_tool_call)) {
      reasons.push(`missing expected tool_call: ${meta.expect_tool_call}`);
    } else if (meta.expect_url_contains) {
      const tc = toolCalls.find(tc => tc.name === meta.expect_tool_call);
      if (!String(tc.args || "").includes(meta.expect_url_contains)) {
        reasons.push(`tool_call ${meta.expect_tool_call} args missing "${meta.expect_url_contains}"`);
      }
    }
  }
  if (meta.expect_reply_match && !rawText.toLowerCase().includes(String(meta.expect_reply_match).toLowerCase())) {
    reasons.push(`reply missing "${meta.expect_reply_match}"`);
  }
  for (const key of Object.keys(meta)) {
    if (!key.startsWith("forbid_reply_match")) continue;
    const forbid = String(meta[key]);
    if (rawText.toLowerCase().includes(forbid.toLowerCase())) {
      reasons.push(`reply contained forbidden "${forbid}"`);
    }
  }
  if (meta.max_tokens && completionTokens > meta.max_tokens) {
    reasons.push(`tokens ${completionTokens} > max ${meta.max_tokens}`);
  }

  return {
    name, pass: reasons.length === 0,
    reason: reasons.join("; ") || "ok",
    duration: Date.now() - start,
    tokens: completionTokens,
    tools: toolCalls.map(tc => tc.name).join(","),
  };
}

(async () => {
  const files = readdirSync(FIXTURES_DIR).filter(f => f.endsWith(".md") && !f.startsWith("_") && f !== "README.md").sort();
  console.log(`[fixtures] Running ${files.length} fixtures against ${URL_BASE}\n`);
  let failed = 0;
  for (const f of files) {
    const content = readFileSync(join(FIXTURES_DIR, f), "utf-8");
    const fixture = parseFixture(content);
    if (!fixture || !fixture.meta.message) { console.log(`  SKIP  ${f} — no frontmatter or message`); continue; }
    const result = await runOne(f, fixture);
    const icon = result.pass ? "PASS" : "FAIL";
    console.log(`  ${icon}  ${f}  (${result.duration}ms, ${result.tokens} tok, tools=[${result.tools}])`);
    if (!result.pass) { console.log(`        → ${result.reason}`); failed++; }
  }
  console.log(`\n[fixtures] ${files.length - failed}/${files.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
})();

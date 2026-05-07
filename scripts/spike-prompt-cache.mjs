// Spike: does Anthropic prompt caching activate when we pass --system-prompt
// to the CLI vs embedding system in stdin text?
//
// Hypothesis: today we embed <system>...</system> in stdin TEXT. The CLI
// sees it all as user content. Anthropic-side caching keys on the
// `system` field of the API request — which is empty in our setup — so
// no caching happens.
//
// Test: spawn one CLI process with --system-prompt set to a 5KB realistic
// chat system prompt, then send 3 different user messages via stdin
// (stream-json). Measure first-byte latency for each. If caching works,
// turn 2 and 3 should be faster than turn 1 (cache hit on the system
// prompt prefix).
//
// Compared to: same 3 messages sent with system embedded in stdin text
// (no --system-prompt). Expect uniform first-byte latency = no caching.

import { spawn } from "node:child_process";

const MODEL = "claude-sonnet-4-6";

// Realistic chat system prompt (~3KB) — mimics shape of full memory + persona
const SYSTEM_PROMPT = `You are Primal, a helpful conversational AI assistant inside Local Agent X. Reply concisely and conversationally — match the user's energy, no preamble.

# Identity
You are Alex's personal AI assistant. Alex is a self-taught builder and the owner of Acme Springfield supplement store. He runs the AgentXOS / Local Agent X project. He's casual, prefers fragment sentences and short answers.

# User context
- Name: Alex
- Role: business owner, self-taught engineer
- Active projects: Local Agent X (LAX), ScanProgress, NaughtyToyDeals, Kraken trading bot
- Working style: action-first, no preamble, casual tone, fragment sentences OK
- Preferences: light mode, no emojis, no AI co-author lines, no Claude/Anthropic mentions in commits

# Recent context
The user has been iterating on the Local Agent X chat performance today — warm pool, canonical chat unification, memory caching. Active focus: making chat fast while preserving memory and tool access.

# Behavior rules
- Match the user's energy. Casual = casual. Technical = technical.
- No filler ("Sure!", "Of course!", "I'd be happy to..."). Just answer.
- After actions, recap what changed in 1-2 sentences.
- Don't mention internal implementation details unless asked.
- For coding tasks, default to perma-fix not bandaid.

This system prompt is intentionally stable across turns to maximize prompt cache hits.`;

function userMessage(text) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  }) + "\n";
}

async function runScenario(name, useSystemFlag) {
  console.log(`\n=== ${name} (--system-prompt ${useSystemFlag ? "USED" : "embedded in stdin"}) ===`);

  const args = [
    "-p",
    "--model", MODEL,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--no-session-persistence",
    "--permission-mode", "plan",
    "--verbose",
    "--disallowed-tools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,TodoWrite,ToolSearch,NotebookEdit,Task,AskUserQuestion,Skill",
  ];

  if (useSystemFlag) {
    args.push("--system-prompt", SYSTEM_PROMPT);
  }

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  let stderr = "";
  proc.stderr?.on("data", (b) => { stderr += b.toString(); });

  const queue = [];
  const waiters = [];
  let buffer = "";
  proc.stdout?.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (waiters.length > 0) waiters.shift()(evt);
        else queue.push(evt);
      } catch { /* skip */ }
    }
  });

  function nextFrame() {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise(r => waiters.push(r));
  }

  // Send a prompt and measure first-text-delta time + result time
  async function sendAndTime(userText) {
    const sentAt = Date.now();
    const wrappedText = useSystemFlag
      ? userText
      : `<system>${SYSTEM_PROMPT}</system>\n${userText}`;
    proc.stdin?.write(userMessage(wrappedText));

    let firstByteAt = null;
    let resultAt = null;
    while (resultAt === null) {
      const evt = await nextFrame();
      if (firstByteAt === null && evt.type === "stream_event") {
        const inner = evt.event;
        if (inner?.type === "content_block_delta") {
          firstByteAt = Date.now();
        }
      }
      if (evt.type === "result") {
        resultAt = Date.now();
        break;
      }
    }
    return {
      firstByte: firstByteAt - sentAt,
      total: resultAt - sentAt,
    };
  }

  const t1 = await sendAndTime("Reply with one short sentence: what's a good way to start the day?");
  const t2 = await sendAndTime("Reply with one short sentence: name a useful productivity habit.");
  const t3 = await sendAndTime("Reply with one short sentence: what's a small but powerful skill?");

  proc.stdin?.end();
  await new Promise(r => proc.on("exit", r));

  console.log(`  Turn 1: first-byte ${t1.firstByte}ms | total ${t1.total}ms`);
  console.log(`  Turn 2: first-byte ${t2.firstByte}ms | total ${t2.total}ms`);
  console.log(`  Turn 3: first-byte ${t3.firstByte}ms | total ${t3.total}ms`);

  const cacheHitDelta = t1.firstByte - t2.firstByte;
  console.log(`  Δ turn1→turn2 first-byte: ${cacheHitDelta}ms ${cacheHitDelta > 500 ? "(suggests caching)" : "(little/no caching)"}`);

  return { t1, t2, t3 };
}

async function main() {
  console.log("[probe] Anthropic prompt-cache activation test");
  console.log("[probe] Model:", MODEL);
  console.log("[probe] System prompt length:", SYSTEM_PROMPT.length, "chars");

  const a = await runScenario("Scenario A: stdin text (current behavior)", false);
  const b = await runScenario("Scenario B: --system-prompt flag", true);

  console.log(`\n=== COMPARISON ===`);
  console.log(`Scenario A turn 1 → 2 first-byte:  ${a.t1.firstByte} → ${a.t2.firstByte}ms`);
  console.log(`Scenario B turn 1 → 2 first-byte:  ${b.t1.firstByte} → ${b.t2.firstByte}ms`);
  console.log(`Scenario A turn 1 → 3 first-byte:  ${a.t1.firstByte} → ${a.t3.firstByte}ms`);
  console.log(`Scenario B turn 1 → 3 first-byte:  ${b.t1.firstByte} → ${b.t3.firstByte}ms`);
  console.log(`==================\n`);
}

main().catch(e => { console.error(e); process.exit(1); });

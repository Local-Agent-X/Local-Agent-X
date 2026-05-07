// Spike: can a single `claude` CLI subprocess handle multiple consecutive
// prompts via --input-format=stream-json? If yes, we have a warm-pool
// primitive: pay the 2-3s CLI cold start ONCE at server boot, drop
// subsequent first-content latency to network round-trip only.
//
// Run:  node scripts/spike-claude-warm-pool.mjs
//
// Success criteria:
//   - Process stays alive after Prompt 1 returns its result
//   - Prompt 2 sent while same process is alive returns a result
//   - Time-to-first-byte on Prompt 2 ≪ time-to-first-byte on Prompt 1

import { spawn } from "node:child_process";

const MODEL = "claude-sonnet-4-6";

// Anthropic Claude Code stream-json input format. Each user message is one
// JSON line on stdin. Documented format from `claude --help`:
//   --input-format stream-json
//   --output-format stream-json
//   --replay-user-messages    (echoes user messages on stdout for ack)
//
// The SDK convention is: { type: "user", message: { role, content } }
function userMessage(text) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  }) + "\n";
}

async function main() {
  console.log("[spike] spawning claude with stream-json IO...");
  const t0 = Date.now();

  const proc = spawn(
    "claude",
    [
      "-p",
      "--model", MODEL,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      "--no-session-persistence",
      "--permission-mode", "plan",
    ],
    { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" },
  );

  let stderr = "";
  proc.stderr?.on("data", (b) => { stderr += b.toString(); });
  proc.on("error", (e) => console.error("[spike] proc error:", e.message));
  proc.on("exit", (code) => console.log(`[spike] proc exit code=${code} (${Date.now() - t0}ms)`));

  // Frame collector: split stdout into newline-delimited JSON
  let buffer = "";
  let firstByteAt = null;
  let firstResultAt = null;
  let secondPromptSentAt = null;
  let secondFirstByteAt = null;
  let secondResultAt = null;
  let promptIdx = 0;
  let lastResultText = "";

  proc.stdout?.on("data", (chunk) => {
    if (firstByteAt === null) {
      firstByteAt = Date.now();
      console.log(`[spike] first byte after ${firstByteAt - t0}ms`);
    }
    if (promptIdx === 1 && secondFirstByteAt === null && secondPromptSentAt) {
      secondFirstByteAt = Date.now();
      console.log(`[spike] PROMPT 2 first byte after ${secondFirstByteAt - secondPromptSentAt}ms`);
    }
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      // Spy on event types — no full content dump
      const type = evt.type;
      const subtype = evt.event?.type;
      console.log(`[spike] frame: type=${type}${subtype ? ` event.type=${subtype}` : ""}`);
      if (type === "result") {
        lastResultText = (evt.result || "").slice(0, 80);
        if (promptIdx === 0) {
          firstResultAt = Date.now();
          console.log(`[spike] PROMPT 1 result after ${firstResultAt - t0}ms: "${lastResultText}"`);
          promptIdx = 1;
          // Send Prompt 2 immediately after first result
          setTimeout(() => sendSecondPrompt(), 100);
        } else {
          secondResultAt = Date.now();
          console.log(`[spike] PROMPT 2 result after ${secondResultAt - secondPromptSentAt}ms: "${lastResultText}"`);
          summarize();
          // Close stdin to let process exit
          proc.stdin?.end();
        }
      }
    }
  });

  // Send Prompt 1
  console.log("[spike] sending PROMPT 1...");
  proc.stdin?.write(userMessage("Reply with exactly the word 'ALPHA' and nothing else."));

  function sendSecondPrompt() {
    secondPromptSentAt = Date.now();
    console.log(`[spike] sending PROMPT 2 at +${secondPromptSentAt - t0}ms (process still alive=${!proc.killed})`);
    proc.stdin?.write(userMessage("Reply with exactly the word 'BRAVO' and nothing else."));
  }

  function summarize() {
    console.log("\n=== SUMMARY ===");
    console.log(`Process alive at PROMPT 2 send:        ${!proc.killed}`);
    console.log(`PROMPT 1 cold start (spawn → result):  ${firstResultAt - t0}ms`);
    console.log(`PROMPT 2 warm time (send → result):    ${secondResultAt - secondPromptSentAt}ms`);
    console.log(`Speedup factor:                        ${((firstResultAt - t0) / (secondResultAt - secondPromptSentAt)).toFixed(2)}×`);
    console.log("================\n");
  }

  // Safety timeout
  setTimeout(() => {
    if (!proc.killed) {
      console.error("[spike] TIMEOUT — killing process. stderr tail:");
      console.error(stderr.slice(-500));
      proc.kill("SIGKILL");
      process.exit(1);
    }
  }, 90_000);
}

main().catch((e) => { console.error(e); process.exit(1); });

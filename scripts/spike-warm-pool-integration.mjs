// Integration probe: drive streamViaWarmPool through the production module
// twice in a row, measure cold-vs-warm latency. Exercises the same code
// path stream-cli.ts uses when LAX_CLAUDE_WARM_POOL=1 and tools=[].

import { streamViaWarmPool, shutdownWarmPool, warmPoolSnapshot } from "../dist/anthropic-client/warm-pool.js";

async function runOne(label, prompt) {
  const t0 = Date.now();
  let firstByteAt = null;
  let resultAt = null;
  let text = "";
  for await (const ev of streamViaWarmPool(
    { model: "claude-sonnet-4-6", permissionMode: "plan" },
    { prompt },
  )) {
    if (ev.type === "text" && ev.delta) {
      if (firstByteAt === null) firstByteAt = Date.now();
      text += ev.delta;
    }
    if (ev.type === "done") {
      resultAt = Date.now();
      break;
    }
    if (ev.type === "error") {
      console.error(`[${label}] ERROR:`, ev.error);
      return;
    }
  }
  console.log(`[${label}] first byte: ${firstByteAt - t0}ms | result: ${resultAt - t0}ms | text: "${text.trim().slice(0, 60)}"`);
  return { firstByte: firstByteAt - t0, total: resultAt - t0 };
}

async function main() {
  console.log("[probe] snapshot before:", warmPoolSnapshot());
  const cold = await runOne("COLD", "Reply with exactly the word ECHO and nothing else.");
  console.log("[probe] snapshot mid:  ", warmPoolSnapshot());
  const warm = await runOne("WARM", "Reply with exactly the word PINGED and nothing else.");
  console.log("[probe] snapshot after:", warmPoolSnapshot());
  if (cold && warm) {
    console.log(`\n=== INTEGRATION RESULTS ===`);
    console.log(`Cold first-byte:  ${cold.firstByte}ms`);
    console.log(`Warm first-byte:  ${warm.firstByte}ms`);
    console.log(`Cold total:       ${cold.total}ms`);
    console.log(`Warm total:       ${warm.total}ms`);
    console.log(`Speedup:          ${(cold.total / warm.total).toFixed(2)}×`);
    console.log(`===========================\n`);
  }
  shutdownWarmPool();
}

main().catch((e) => { console.error(e); process.exit(1); });

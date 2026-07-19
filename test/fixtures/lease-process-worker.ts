import { existsSync, writeFileSync } from "node:fs";

const [action, opId, owner, generationRaw, gateDir] = process.argv.slice(2);
const { acquireLease, heartbeatLease, releaseLease } = await import("../../src/canonical-loop/lease.js");

if (action === "acquire") {
  writeFileSync(`${gateDir}/ready-${owner}`, "ready");
  while (!existsSync(`${gateDir}/go`)) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  process.stdout.write(`@@RESULT@@${JSON.stringify(acquireLease(opId, owner))}`);
} else {
  const claim = { owner, generation: Number(generationRaw) };
  const result = action === "heartbeat"
    ? heartbeatLease(opId, claim)
    : releaseLease(opId, claim);
  process.stdout.write(`@@RESULT@@${JSON.stringify(result)}`);
}

// Reading an isolated server's op store — shared by the op-outcomes battery and
// the aider-polyglot rig so both grade the same facts the same way.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every op the run created, with its directory. Ops still being written are skipped. */
export function readOps(dataDir) {
  const root = join(dataDir, "operations");
  if (!existsSync(root)) return [];
  const ops = [];
  for (const id of readdirSync(root)) {
    try { ops.push({ dir: join(root, id), op: JSON.parse(readFileSync(join(root, id, "operation.json"), "utf8")) }); } catch { /* still being written */ }
  }
  return ops;
}

/** Models the run's CHAT turns were actually served by. A result that ran on a
 *  different model than the one configured (a silent provider fallback) says
 *  nothing about the model under test. */
export function chatModelsIn(dataDir) {
  const models = new Set();
  for (const { dir, op } of readOps(dataDir)) {
    if (op.type !== "chat_turn") continue;
    const turnsDir = join(dir, "op-turns");
    for (const f of existsSync(turnsDir) ? readdirSync(turnsDir) : []) {
      try {
        const model = JSON.parse(readFileSync(join(turnsDir, f), "utf8")).turn?.providerState?.providerPayload?.model;
        if (model) models.add(model);
      } catch { /* partial write */ }
    }
  }
  return [...models];
}

/** Model turns the run's CHAT ops completed — how much the model actually got to do. */
export function opTurnCount(dataDir) {
  let n = 0;
  for (const { dir, op } of readOps(dataDir)) {
    if (op.type !== "chat_turn") continue;
    const turnsDir = join(dir, "op-turns");
    if (existsSync(turnsDir)) n += readdirSync(turnsDir).length;
  }
  return n;
}

/** Wait until no op is pending/running. Null when idle, else a reason string. */
export async function waitForIdleOps(dataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = readOps(dataDir).filter(({ op }) => op.status === "pending" || op.status === "running");
    if (active.length === 0) return null;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return `background ops still running after ${Math.round(timeoutMs / 1000)}s`;
}

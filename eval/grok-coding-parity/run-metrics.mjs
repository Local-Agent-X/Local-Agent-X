// What one battery run cost and ran into, read from the isolated server's op
// store (never the live app's): model steps, tool calls, blocked and failed
// calls, and each harness guard that fired. The scenario's check scores the
// RESULT; these say how the model got there, so a provider or harness change
// that keeps the pass rate but doubles the steps or the refusals shows up.
//
// Same sources as scripts/score-guards.mjs: op-turns/<n>.json for the steps
// and their tool results ("[ok …]", "[blocked …]", "[error …]"), and the
// `middleware_fired` events in canonical-events.jsonl for the guards.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }

/** The ops a session ran on this server. */
function opDirsFor(dataDir, sessionId) {
  const root = join(dataDir, "operations");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => join(root, id))
    .filter((dir) => readJson(join(dir, "operation.json"))?.sessionId === sessionId);
}

function turnFiles(opDir) {
  const dir = join(opDir, "op-turns");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => join(dir, f));
}

function guardsFired(opDir, into) {
  const path = join(opDir, "canonical-events.jsonl");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes("middleware_fired")) continue;
    try {
      const e = JSON.parse(line);
      const name = e.type === "middleware_fired" ? e.body?.name : null;
      if (name) into[name] = (into[name] ?? 0) + 1;
    } catch { /* a torn last line */ }
  }
}

/** { ops, steps, toolCalls, blocked, failed, guards: { name: count } } */
export function runMetrics(dataDir, sessionId) {
  const out = { ops: 0, steps: 0, toolCalls: 0, blocked: 0, failed: 0, guards: {} };
  if (!dataDir) return out;
  for (const opDir of opDirsFor(dataDir, sessionId)) {
    out.ops += 1;
    for (const file of turnFiles(opDir)) {
      out.steps += 1;
      for (const m of readJson(file)?.messages ?? []) {
        if (m.role === "assistant") out.toolCalls += m.content?.toolCalls?.length ?? 0;
        if (m.role !== "tool_result") continue;
        const head = String(m.content?.result ?? "").slice(0, 10);
        if (head.startsWith("[blocked")) out.blocked += 1;
        else if (head.startsWith("[error")) out.failed += 1;
      }
    }
    guardsFired(opDir, out.guards);
  }
  return out;
}

/** "12 steps, 18 calls, 2 blocked, 1 failed, guards: budget-ladder×1" */
export function formatMetrics(m) {
  const guards = Object.entries(m.guards).map(([g, n]) => `${g}×${n}`).join(", ");
  return `${m.steps} steps, ${m.toolCalls} calls, ${m.blocked} blocked, ${m.failed} failed${guards ? `, guards: ${guards}` : ""}`;
}

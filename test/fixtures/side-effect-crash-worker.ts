import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dispatchSingleToolCall } from "../../src/tool-execution/execute-tool.js";
import { _setSideEffectJournalHookForTests } from "../../src/tool-execution/side-effect-journal.js";
import { setAriRequired } from "../../src/ari-kernel/state.js";
import type { ToolDefinition, ToolResult } from "../../src/types.js";

const [action, ledgerPath, opId, toolCallId, effectClass, crashPhase] = process.argv.slice(2);

if (action === "sweep") {
  const { sweepStaleCanonicalOps } = await import("../../src/canonical-loop/recovery.js");
  process.stdout.write(`@@RESULT@@${JSON.stringify(sweepStaleCanonicalOps())}`);
  process.exit(0);
}

if (crashPhase) {
  _setSideEffectJournalHookForTests((phase) => {
    if (phase === crashPhase) process.exit(86);
  });
}

setAriRequired(false);

function rows(): Array<{ opId: string; key?: string }> {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as { opId: string; key?: string });
}

const operationKey = `external-key-${opId}`;
const tool: ToolDefinition = {
  name: "external_mutation",
  description: "crash fixture",
  parameters: { type: "object" },
  effect: effectClass === "keyed-mutation"
    ? { class: "keyed-mutation", operationKey }
    : { class: "non-idempotent" },
  async execute(): Promise<ToolResult> {
    const prior = rows();
    if (effectClass !== "keyed-mutation" || !prior.some(row => row.key === operationKey)) {
      appendFileSync(ledgerPath, `${JSON.stringify({ opId, key: effectClass === "keyed-mutation" ? operationKey : undefined })}\n`);
    }
    return { content: `receipt:${opId}`, metadata: { operationKey } };
  },
};

const result = await dispatchSingleToolCall(
  { id: toolCallId, name: tool.name, args: { operationKey, payload: "fixed" } },
  {
    toolMap: new Map([[tool.name, tool]]),
    security: undefined as never,
    sessionId: `session-${opId}`,
    operationId: opId,
    callContext: "local",
  },
);
process.stdout.write(`@@RESULT@@${JSON.stringify(result)}`);
process.exit(0);

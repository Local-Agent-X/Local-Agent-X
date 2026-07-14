import { executeToolCalls } from "../../tool-execution/execute-tool.js";
import type { SecurityLayer } from "../../security/index.js";
import type { ToolDefinition } from "../../types.js";
import type { ToolPolicy } from "../../tool-policy/index.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("memory.canary");

// End-to-end self-test for the durable memory WRITE path. CI tests prove the
// pipeline at build time; this proves it in the running app the user actually
// has — an OTA update that breaks any dispatch hop between the promotion gate
// and the sink (the Jul 2026 retry-clone outage sat in exactly that gap,
// erroring in the log for two days) surfaces as a UI banner within one
// interval instead of "my assistant says memory is blocked".
//
// One remember → forget round trip through executeToolCalls — the same entry
// the chat runner dispatches through. No LLM involved; cost is two local DB
// writes. The canary session never runs ingesting tools, so it stays clean
// and the write must succeed SILENTLY; an approval prompt here is a failure.

export interface MemoryCanaryStatus {
  state: "ok" | "failing" | "unknown";
  lastRunAt?: number;
  lastOkAt?: number;
  consecutiveFailures: number;
  failure?: string;
}

const status: MemoryCanaryStatus = { state: "unknown", consecutiveFailures: 0 };

export function getMemoryCanaryStatus(): MemoryCanaryStatus {
  return { ...status };
}

export const MEMORY_CANARY_SESSION = "memory-canary-internal";

function toolText(msgs: Awaited<ReturnType<typeof executeToolCalls>>): string {
  const toolMsg = msgs.find((message) => message.role === "tool");
  return String(toolMsg?.content ?? "(no tool message)");
}

export function makeRunMemoryCanary(deps: {
  security: SecurityLayer;
  toolPolicy: ToolPolicy;
  allAgentTools: ToolDefinition[];
  broadcast: (event: Record<string, unknown>) => void;
}): () => Promise<void> {
  const { security, toolPolicy, allAgentTools, broadcast } = deps;

  const dispatch = async (name: string, args: Record<string, unknown>, nonce: string) => {
    const toolMap = new Map(allAgentTools.map((tool) => [tool.name, tool]));
    const msgs = await executeToolCalls(
      [{ id: `canary-${name}-${nonce}`, name, arguments: JSON.stringify(args) }],
      toolMap,
      security,
      toolPolicy,
      undefined, undefined, undefined,
      MEMORY_CANARY_SESSION,
      undefined, undefined,
      [{ role: "user", content: "internal memory write self-test" }],
      undefined, undefined,
      "local",
    );
    return toolText(msgs);
  };

  const record = (failure: string | null) => {
    const wasFailing = status.state === "failing";
    status.lastRunAt = Date.now();
    if (failure === null) {
      status.state = "ok";
      status.lastOkAt = status.lastRunAt;
      status.consecutiveFailures = 0;
      delete status.failure;
      if (wasFailing) {
        logger.info("[canary] memory write path recovered");
        broadcast({ type: "system_health", subsystem: "memory-writes", state: "ok" });
      }
      return;
    }
    status.state = "failing";
    status.consecutiveFailures += 1;
    status.failure = failure;
    logger.error(`[canary] memory write path FAILING (#${status.consecutiveFailures}): ${failure}`);
    // Broadcast every failing run, not just the transition — a client that
    // connected after the first failure still needs to hear about it.
    broadcast({
      type: "system_health",
      subsystem: "memory-writes",
      state: "failing",
      message: `Durable memory writes are failing: ${failure}`,
    });
  };

  return async () => {
    const nonce = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    const marker = `memory-canary-${nonce}`;
    try {
      const remembered = await dispatch("remember", {
        content: `Internal self-test fact ${marker} (auto-removed)`,
      }, nonce);
      if (!/^Remembered/.test(remembered)) {
        record(`remember: ${remembered.slice(0, 300)}`);
        return;
      }
      const forgotten = await dispatch("forget", { query: marker }, nonce);
      if (!/^Forgot fact/.test(forgotten)) {
        record(`forget (write landed but round-trip broke): ${forgotten.slice(0, 300)}`);
        return;
      }
      record(null);
    } catch (e) {
      record(`threw: ${(e as Error).message}`);
    }
  };
}

import { bridgeOpCancelToToolSignal } from "../cancel-handler.js";
import { opCancel } from "../control-api.js";
import type { CanonicalChatContext } from "../chat-runner.js";
import { createLogger } from "../../logger.js";
import { createEventPump, type EventPump } from "./event-pump.js";
import { registerChatRuntime, type ChatRuntimeRegistration } from "./runtime-registration.js";
import type { OpenAICompatTarget } from "../adapters/openai-compat.js";

const logger = createLogger("canonical-loop.chat-runner");

export interface ChatLifecycle {
  pump: EventPump;
  dispose(): void;
}

export async function createChatLifecycle(
  opId: string,
  ctx: CanonicalChatContext,
  resolvedTarget: OpenAICompatTarget | null,
): Promise<ChatLifecycle> {
  const cancelBridge = bridgeOpCancelToToolSignal(opId, ctx.signal);
  let externalAbortListener: (() => void) | null = null;
  let runtime: ChatRuntimeRegistration | null = null;
  let pump: EventPump | null = null;

  const dispose = () => {
    pump?.dispose();
    cancelBridge.dispose();
    if (externalAbortListener && ctx.signal) {
      ctx.signal.removeEventListener("abort", externalAbortListener);
    }
    runtime?.dispose();
  };

  try {
    if (ctx.signal) {
      externalAbortListener = () => {
        logger.info(`[chat-runner] op ${opId} received external abort signal - issuing opCancel`);
        opCancel(opId, "external-signal");
      };
      if (ctx.signal.aborted) externalAbortListener();
      else ctx.signal.addEventListener("abort", externalAbortListener, { once: true });
    }
    runtime = await registerChatRuntime(opId, ctx, cancelBridge.signal, resolvedTarget);
    pump = createEventPump(opId);
    return { pump, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

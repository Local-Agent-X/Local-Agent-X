import type { AgencyAgent, AgencyConfig, AgencyTask } from "../types.js";
import { EventBus } from "../../event-bus.js";

export interface HeadlessRunContext {
  config: AgencyConfig;
  addTokens: (n: number) => void;
}

export async function runHeadlessAgent(
  ctx: HeadlessRunContext,
  task: AgencyTask,
  prompt: string,
  agent: AgencyAgent | undefined
): Promise<string> {
  const responsePromise = new Promise<string>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new Error(`Agent task timed out: ${task.id}`));
    }, ctx.config.timeout);

    const handler = (data: unknown) => {
      const d = data as {
        taskId: string;
        result?: string;
        error?: string;
        tokens?: number;
      };
      if (d.taskId !== task.id) return;
      clearTimeout(timeoutHandle);
      EventBus.off("agency:agent-result", handler);
      if (d.tokens) ctx.addTokens(d.tokens);
      if (d.error) {
        reject(new Error(d.error));
      } else {
        resolve(d.result ?? "");
      }
    };

    EventBus.on("agency:agent-result", handler);
  });

  await EventBus.emit("agency:agent-run", {
    taskId: task.id,
    agentId: agent?.id,
    role: agent?.role,
    systemPrompt: agent?.systemPrompt,
    tools: agent?.tools,
    prompt,
    provider: ctx.config.provider,
    model: ctx.config.model,
  });

  return responsePromise;
}

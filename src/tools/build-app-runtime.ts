import { workspaceRoot } from "../config.js";
import {
  makeChatToolDispatcher,
  registerAdapterForOp,
  registerToolDispatcherForOp,
  registerToolsForOp,
} from "../canonical-loop/index.js";
import { createAppBuildAdapter } from "../canonical-loop/public/build-adapters.js";
import { SecurityLayer } from "../security/index.js";
import { loadFileAccessModeAtLeast } from "../security/layer/index.js";
import type { AppBuildRuntimeDescriptor, Op } from "../ops/types.js";
import { listOps } from "../ops/op-store.js";
import { setSessionWorkRoot } from "../workspace/paths.js";
import { readTool, writeTool, editTool } from "./file-tools.js";
import { bashTool } from "./shell-tools.js";
import { globTool } from "./glob-tool.js";
import { connectorCreateTool } from "./connector-tools.js";
import { processStartTool, processStatusTool, processKillTool } from "./process-tools-defs.js";
import { appServeBackendTool, appServeFrontendTool } from "./dev-server-tools.js";
import type { AppTier } from "./app-tier.js";

const BASE_TOOLS = [writeTool, readTool, editTool, bashTool, globTool, connectorCreateTool];

export function builderToolsForTier(tier: AppTier): typeof BASE_TOOLS {
  if (tier === "quick-html") return BASE_TOOLS;
  const withProcess = [...BASE_TOOLS, processStartTool, processStatusTool, processKillTool];
  if (tier === "full-stack" || tier === "frontend-spa") {
    return [...withProcess, appServeBackendTool, appServeFrontendTool];
  }
  return withProcess;
}

export function registerAppBuildRuntime(op: Op, descriptor: AppBuildRuntimeDescriptor): void {
  const tools = builderToolsForTier(descriptor.tier ?? "quick-html");
  setSessionWorkRoot(op.id, descriptor.appDir);
  registerToolsForOp(op.id, tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  })));

  if (descriptor.strategy === "in-canonical-sub-agent") {
    const security = new SecurityLayer(workspaceRoot(), loadFileAccessModeAtLeast("common"));
    security.addAllowedPath(descriptor.appDir, op.id);
    registerToolDispatcherForOp(op.id, makeChatToolDispatcher({
      tools,
      security,
      sessionId: op.id,
      callContext: "delegated",
      opId: op.id,
    }));
  }

  registerAdapterForOp(op.id, () => createAppBuildAdapter({
    strategy: descriptor.strategy,
    provider: descriptor.provider,
    appName: descriptor.appName,
    appDir: descriptor.appDir,
    appUrl: descriptor.appUrl,
    prompt: descriptor.prompt,
    brief: descriptor.brief,
    systemPrompt: descriptor.systemPrompt,
    model: descriptor.model,
    tier: descriptor.tier,
    sessionId: descriptor.adapterSessionId ?? op.id,
  }));
}

export function restorePersistedAppBuildRuntimes(ops: Op[] = listOps()): string[] {
  const restored: string[] = [];
  for (const op of ops) {
    const descriptor = op.runtimeDescriptor;
    const state = op.canonical?.state;
    if (op.type !== "app_build" || descriptor?.kind !== "app-build") continue;
    if (state === "succeeded" || state === "failed" || state === "cancelled") continue;
    registerAppBuildRuntime(op, descriptor);
    restored.push(op.id);
  }
  return restored;
}

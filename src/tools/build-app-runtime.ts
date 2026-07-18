import { workspaceRoot } from "../config.js";
import {
  makeChatToolDispatcher,
  registerAdapterForOp,
  registerToolDispatcherForOp,
  registerToolsForOp,
  unregisterAdapterForOp,
  unregisterToolDispatcherForOp,
  unregisterToolsForOp,
} from "../canonical-loop/index.js";
import { createAppBuildAdapter } from "../canonical-loop/public/build-adapters.js";
import type { Adapter } from "../canonical-loop/adapter-contract.js";
import { SecurityLayer } from "../security/index.js";
import { loadFileAccessModeAtLeast } from "../security/layer/index.js";
import type { AppBuildRuntimeDescriptor, Op } from "../ops/types.js";
import { listOps } from "../ops/op-store.js";
import { clearSessionWorkRoot, setSessionWorkRoot } from "../workspace/paths.js";
import { readTool, writeTool, editTool } from "./file-tools.js";
import { bashTool } from "./shell-tools.js";
import { globTool } from "./glob-tool.js";
import { connectorCreateTool } from "./connector-tools.js";
import { processStartTool, processStatusTool, processKillTool } from "./process-tools-defs.js";
import { appServeBackendTool, appServeFrontendTool } from "./dev-server-tools.js";
import type { AppTier } from "./app-tier.js";
import { checkProductBuildOwnership } from "./build-app-collision.js";

const BASE_TOOLS = [writeTool, readTool, editTool, bashTool, globTool, connectorCreateTool];

export function builderToolsForTier(tier: AppTier): typeof BASE_TOOLS {
  if (tier === "quick-html") return BASE_TOOLS;
  const withProcess = [...BASE_TOOLS, processStartTool, processStatusTool, processKillTool];
  if (tier === "full-stack" || tier === "frontend-spa") {
    return [...withProcess, appServeBackendTool, appServeFrontendTool];
  }
  return withProcess;
}

export interface AppBuildRuntimeRegistration {
  registered: boolean;
  errorMessage?: string;
}

function clearAppBuildRuntime(opId: string): void {
  unregisterAdapterForOp(opId);
  unregisterToolDispatcherForOp(opId);
  unregisterToolsForOp(opId);
  clearSessionWorkRoot(opId);
}

function productBuildBlockedAdapter(message: string): Adapter {
  return {
    name: "app-build-product-owned",
    version: "1",
    async runTurn(_input, report) {
      report({
        kind: "error",
        code: "product_build_owns_project",
        message,
        retryable: false,
      });
      return {
        providerState: {
          adapterName: "app-build-product-owned",
          adapterVersion: "1",
          providerPayload: null,
        },
        terminalReason: "error",
      };
    },
    async abort() { /* nothing is running */ },
  };
}

function registerBlockedAppBuildRuntime(opId: string, message: string): void {
  clearAppBuildRuntime(opId);
  registerAdapterForOp(opId, () => productBuildBlockedAdapter(message));
}

export function registerAppBuildRuntime(
  op: Op,
  descriptor: AppBuildRuntimeDescriptor,
): AppBuildRuntimeRegistration {
  const ownership = checkProductBuildOwnership(descriptor.appDir, descriptor.appName);
  if (ownership.blocked) {
    return { registered: false, errorMessage: ownership.errorMessage };
  }

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

  registerAdapterForOp(op.id, () => {
    const latestOwnership = checkProductBuildOwnership(descriptor.appDir, descriptor.appName);
    if (latestOwnership.blocked) {
      unregisterToolDispatcherForOp(op.id);
      unregisterToolsForOp(op.id);
      clearSessionWorkRoot(op.id);
      return productBuildBlockedAdapter(latestOwnership.errorMessage ?? "Product Build owns this project.");
    }
    return createAppBuildAdapter({
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
    });
  });
  return { registered: true };
}

export function restorePersistedAppBuildRuntimes(ops: Op[] = listOps()): string[] {
  const restored: string[] = [];
  for (const op of ops) {
    const descriptor = op.runtimeDescriptor;
    const state = op.canonical?.state;
    if (op.type !== "app_build" || descriptor?.kind !== "app-build") continue;
    if (state === "succeeded" || state === "failed" || state === "cancelled") continue;
    const registration = registerAppBuildRuntime(op, descriptor);
    if (!registration.registered) {
      registerBlockedAppBuildRuntime(
        op.id,
        registration.errorMessage ?? "Product Build owns this project.",
      );
      continue;
    }
    restored.push(op.id);
  }
  return restored;
}

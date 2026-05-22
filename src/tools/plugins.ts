import type { ToolDefinition } from "../types.js";
import type { ToolPlugin } from "./plugin.js";
import { allTools, createHttpRequestTool, buildToolRegistry } from "../tools.js";
import { appTools } from "../app-tools.js";
import { issueTools } from "../issue-tools.js";
import { imageTools } from "../image-tools.js";
import { createSecretTools } from "../secret-tools.js";
import { createBrowserTools } from "../browser-tools.js";
import { createCoreProtocolTools } from "../protocols.js";
import { createCronTools } from "../cron-service.js";
import { createAgencyTools } from "../agency/index.js";
import { createHandlerTools } from "../agency/handler.js";
import { createAgentTools } from "../agents/tools.js";
import { createMemoryTools } from "../memory.js";
import { createArikernelBridgeTools } from "./arikernel-bridge.js";

const SESSION_ONEVENT_TOOLS = new Set(["request_secret", "request_secrets"]);

const ARI_BRIDGE_CLASS: Record<string, "file" | "http" | "shell" | "database" | "retrieval"> = {
  ari_file: "file",
  ari_http: "http",
  ari_shell: "shell",
  ari_database: "database",
  ari_retrieval: "retrieval",
};

export const plugins: ToolPlugin[] = [
  {
    id: "core",
    async register(ctx) {
      // Seeds allTools into the registry with audience-based defer flags.
      // The bootstrap loop's "already registered? skip" check then leaves
      // those entries alone; the three extras below land with defer:true.
      buildToolRegistry();
      const { installSoftwareTool } = await import("./install-software.js");
      const { settingTool } = await import("./setting-tool.js");
      return [...allTools, createHttpRequestTool(ctx.secretsStore), installSoftwareTool, settingTool];
    },
  },
  {
    id: "memory",
    register(ctx) {
      return createMemoryTools(ctx.memoryIndex);
    },
  },
  {
    id: "secrets",
    register(ctx) {
      const tools = createSecretTools(ctx.secretsStore, undefined);
      // request_secret / request_secrets emit events back to the calling
      // session. Wrap them so each call looks up the session's onEvent at
      // execute time via _sessionId injected by the tool executor.
      for (let i = 0; i < tools.length; i++) {
        const tool = tools[i];
        if (!SESSION_ONEVENT_TOOLS.has(tool.name)) continue;
        const toolName = tool.name;
        tools[i] = {
          ...tool,
          execute: async (args, signal) => {
            const sessionId = args._sessionId ? String(args._sessionId) : "";
            const onEvent = sessionId ? ctx.activeOnEventBySession.get(sessionId) : undefined;
            const fresh = createSecretTools(ctx.secretsStore, onEvent).find(t => t.name === toolName);
            if (!fresh) throw new Error(`Tool ${toolName} not found`);
            return fresh.execute(args, signal);
          },
        };
      }
      return tools;
    },
  },
  {
    id: "browser",
    register(ctx) {
      return createBrowserTools(() => ctx.activeBrowserSessionIdRef.value);
    },
  },
  {
    id: "browserSecretCapture",
    async register(ctx) {
      const { createBrowserSecretCaptureTool } = await import("../browser-secret-capture.js");
      return [createBrowserSecretCaptureTool(ctx.secretsStore, () => ctx.activeBrowserSessionIdRef.value)];
    },
  },
  {
    id: "browserSecretFill",
    async register(ctx) {
      const { createBrowserSecretFillTool } = await import("../browser-secret-fill.js");
      return [createBrowserSecretFillTool(ctx.secretsStore, () => ctx.activeBrowserSessionIdRef.value)];
    },
  },
  {
    id: "sessionStatus",
    async register(ctx) {
      const { createSessionStatusTool } = await import("../session-status-tool.js");
      return [createSessionStatusTool(() => ctx.activeBrowserSessionIdRef.value)];
    },
  },
  {
    id: "voiceVisual",
    async register() {
      const { createVoiceVisualTool } = await import("../voice/voice-visual-tool.js");
      return [createVoiceVisualTool()];
    },
  },
  {
    id: "images",
    register() { return imageTools; },
  },
  {
    id: "protocols",
    register() { return createCoreProtocolTools(); },
  },
  {
    id: "cron",
    register(ctx) { return createCronTools(ctx.cronService); },
  },
  {
    id: "agents",
    register() { return createAgentTools(); },
  },
  {
    id: "agency",
    register() { return createAgencyTools(); },
  },
  {
    id: "handlers",
    register() { return createHandlerTools(); },
  },
  {
    id: "apps",
    register(ctx) {
      // build_app picks its subprocess provider via resolveBuildProvider,
      // which by default falls back to ~/.lax/settings.json. The chat's
      // active CLI choice (per-session) should win — inject
      // _runtimeProvider/_runtimeModel from activeRuntimeBySession so the
      // tool's executor can forward them as forcedProvider.
      return appTools.map((t): ToolDefinition => {
        if (t.name !== "build_app") return t;
        const original = t;
        return {
          ...original,
          execute: async (args, signal) => {
            const sessionId = args._sessionId ? String(args._sessionId) : "";
            const runtime = sessionId ? ctx.activeRuntimeBySession.get(sessionId) : undefined;
            if (runtime && args._runtimeProvider === undefined) {
              args._runtimeProvider = runtime.provider;
              args._runtimeModel = runtime.model;
            }
            return original.execute(args, signal);
          },
        };
      });
    },
  },
  {
    id: "issues",
    register() { return issueTools; },
  },
  {
    id: "operations",
    async register() {
      const { createOperationTools } = await import("../operations/tools.js");
      return createOperationTools();
    },
  },
  {
    id: "arikernelBridge",
    // Per-tool toolClass differs across bridges, so this plugin self-registers
    // into ctx.registry with the right metadata. Bootstrap's dedup-by-name
    // pass then leaves these alone and just collects them into allAgentTools.
    register(ctx) {
      const tools = createArikernelBridgeTools();
      for (const bridge of tools) {
        const cls = ARI_BRIDGE_CLASS[bridge.name];
        ctx.registry.register(bridge, {
          defer: true,
          tags: ["arikernel", "kernel-bridge", ...(cls ? [cls] : [])],
          searchHint: bridge.description.slice(0, 80),
          toolClass: cls,
        });
      }
      return tools;
    },
  },
];

/** Plugin ids whose tools belong in bridgeTools[] (chat-runner subset). */
export const BRIDGE_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "memory", "browserSecretCapture", "sessionStatus", "browser", "images", "protocols", "issues",
]);

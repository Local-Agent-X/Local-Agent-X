/**
 * build_app — the canonical-loop app builder.
 *
 * Spawns an `app_build` canonical op rather than blocking the chat turn on
 * a CLI subprocess. Returns immediately with an op-submitted chip; progress
 * streams in the AGENTS sidebar; APP_READY: <url> emits when done.
 *
 * Strategy split (from the app-builder agent template's providerStrategy):
 *   - codex / anthropic → cli-subprocess (preserves the subscription-endpoint
 *     truncation workaround the CLI path relies on; cancel kills the
 *     subprocess tree via the adapter's AbortController).
 *   - everyone else      → in-canonical-sub-agent (provider's HTTP adapter
 *     drives the turn_loop with write/read/edit/bash/glob tools).
 *
 * This tool is the collapse of the legacy build_app + build_app_canonical.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolDefinition } from "../types.js";
import {
  renderPerBuildContext,
  renderPersonaPrompt,
  listAssetsDir,
  readUpdateContextFiles,
  renderBuilderPrompt,
} from "./render-builder-prompt.js";
import { AgentTemplateStore, type AgentExecStrategy } from "../agent-store.js";
import { buildContextPack } from "../ops/context-pack-builder.js";
import { newOpId } from "../ops/op-store.js";
import { getRetryPolicy } from "../ops/heartbeat.js";
import { trackOpForSession } from "../ops/session-bridge.js";
import {
  canonicalLoopEntry,
  registerAdapterForOp,
  registerToolDispatcherForOp,
  registerToolsForOp,
  appendOpMessage,
} from "../canonical-loop/index.js";
import { createAppBuildAdapter } from "../canonical-loop/adapters/app-build-adapter.js";
import { makeChatToolDispatcher } from "../canonical-loop/chat-tool-dispatcher.js";
import { SecurityLayer } from "../security.js";
import type { Op, OpVisibility } from "../ops/types.js";
import { readTool, writeTool, editTool } from "./file-tools.js";
import { bashTool } from "./shell-tools.js";
import { globTool } from "../glob-tool.js";

/** Tool defs the in-canonical-sub-agent strategy hands to the agent. Mirrors
 *  the app-builder template's allowedTools verbatim. */
const BUILDER_AGENT_TOOLS = [writeTool, readTool, editTool, bashTool, globTool];

export const APP_BUILD_OP_TYPE = "app_build";

export interface BuildAppResolveOptions {
  /** ~/.lax/settings.json lookup path — override for tests. */
  settingsPath?: string;
  /** Override the effective provider, bypassing settings.json. */
  forcedProvider?: string;
}

/**
 * Decide whether the chat's runtime provider should be forced over the
 * settings.json fallback. Explicit `backend` arguments (codex/claude) take
 * precedence over the chat's runtime, so we only forward `runtimeProvider`
 * when the caller asked for "auto" (or didn't pass one). Pure helper so the
 * precedence logic is unit-testable without queuing a real op.
 */
export function pickForcedProviderFromRuntime(
  backendArg: string,
  runtimeProvider: string | undefined,
): string | undefined {
  if (backendArg && backendArg !== "auto") return undefined;
  return runtimeProvider || undefined;
}

export function resolveBuildProvider(
  backendArg: string,
  opts: BuildAppResolveOptions = {},
): string {
  if (opts.forcedProvider) return opts.forcedProvider;
  if (backendArg === "codex") return "codex";
  if (backendArg === "claude" || backendArg === "anthropic") return "anthropic";
  if (backendArg && backendArg !== "auto") return backendArg;
  try {
    const settingsPath = opts.settingsPath
      ?? join(process.env.HOME || process.env.USERPROFILE || homedir(), ".lax", "settings.json");
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (typeof s.provider === "string" && s.provider.length > 0) return s.provider;
    }
  } catch { /* fall through */ }
  return "anthropic";
}

export function resolveBuildStrategy(provider: string): AgentExecStrategy {
  const template = AgentTemplateStore.getInstance().get("app-builder");
  const strategy = template?.providerStrategy ?? {};
  return (strategy[provider] ?? strategy.default ?? "in-canonical-sub-agent");
}

export const buildAppTool: ToolDefinition = {
  name: "build_app",
  description:
    "Build a complete web app in workspace/apps/. Returns an op id immediately; the build runs as an app_build canonical op (sidebar streams progress; APP_READY: <url> emits on completion). Use this for NEW apps and LARGE rewrites. For small edits to existing apps, prefer read + edit directly.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "App directory name (e.g. 'trading-bot', 'todo-app')" },
      prompt: { type: "string", description: "Build brief — what to make, target features, styling notes, behavior. Be specific." },
      backend: { type: "string", enum: ["codex", "claude", "auto"], description: "Which CLI to use. 'auto' (default) matches your active provider. 'codex' = codex CLI. 'claude' = claude CLI." },
    },
    required: ["name", "prompt"],
  },
  async execute(args) {
    const appName = String(args.name || "app").replace(/[^a-zA-Z0-9_-]/g, "-");
    // Some models occasionally emit `description` instead of `prompt`. Live
    // failure 2026-05-14 on Anthropic Opus 4.7 — prompt missing, description
    // present. Schema docs the right key; alias keeps back-compat.
    const prompt = String(args.prompt || args.description || "");
    const backend = String(args.backend || "auto");
    const sessionId = String(args._sessionId || "");
    // The chat turn handler stamps args._runtimeProvider/_runtimeModel via
    // the bootstrap-tools wrapper around build_app. When the LLM didn't
    // pin an explicit backend, prefer the chat's active provider so the
    // dropdown selection wins over whatever's stale in ~/.lax/settings.json.
    const runtimeProvider = args._runtimeProvider ? String(args._runtimeProvider) : undefined;
    const forcedProvider = pickForcedProviderFromRuntime(backend, runtimeProvider);

    const provider = resolveBuildProvider(backend, forcedProvider ? { forcedProvider } : {});
    const strategy = resolveBuildStrategy(provider);

    const appDir = resolve("workspace", "apps", appName);
    const port = process.env.LAX_PORT ?? process.env.SAX_PORT ?? "7007";
    const appUrl = `http://127.0.0.1:${port}/apps/${appName}/index.html`;
    mkdirSync(appDir, { recursive: true });

    const isUpdate = existsSync(resolve(appDir, "index.html"));
    const contextFiles = isUpdate ? readUpdateContextFiles(appDir) : [];
    const assetFiles = listAssetsDir(appDir);

    const perBuildContext = renderPerBuildContext({
      appName, prompt, appDir, appUrl, isUpdate, contextFiles, assetFiles,
    });
    // cli-subprocess path expects the full legacy prompt (per-build context
    // + WEBSITE_RULES_FRAGMENT when applicable). Composed via the legacy
    // renderer so the subprocess gets a byte-identical prompt to pre-migration.
    const cliPrompt = renderBuilderPrompt({
      appName, prompt, appDir, appUrl, isUpdate, contextFiles, assetFiles,
    });

    const contextPack = await buildContextPack({
      description: `Build app "${appName}" (${strategy})`,
      successCriteria: [`APP_READY: <url> emitted`, `index.html written to ${appDir}`],
      constraints: [],
      lane: "build",
      preferredProvider: provider,
      budget: {
        maxIterations: 50,
        maxWallTimeMs: 10 * 60 * 1000,
      },
    });

    const op: Op = {
      id: newOpId(`op_${APP_BUILD_OP_TYPE}`),
      type: APP_BUILD_OP_TYPE,
      task: `Build app "${appName}"`,
      contextPack,
      lane: "build",
      retryPolicy: getRetryPolicy(APP_BUILD_OP_TYPE),
      ownerId: "local-user",
      visibility: "private" as OpVisibility,
      status: "pending",
      createdAt: new Date().toISOString(),
      attemptCount: 0,
    };

    if (sessionId) trackOpForSession(op.id, sessionId, op.task);

    const personaPrompt = renderPersonaPrompt();

    // Pre-seed the turn-0 user message with the per-build context so the
    // in-canonical agent sees the exact prompt the legacy CLI received. The
    // worker's seedInitialUserMessage will see this and skip its own seeding.
    // For cli-subprocess this row is harmless (the adapter ignores message
    // history), but keeping it consistent simplifies the test surface.
    appendOpMessage({
      messageId: `um-${op.id}-init-${randomUUID().slice(0, 8)}`,
      opId: op.id,
      turnIdx: 0,
      seqInTurn: 0,
      role: "user",
      content: { text: perBuildContext },
      createdAt: new Date().toISOString(),
    });

    if (strategy === "in-canonical-sub-agent") {
      registerToolsForOp(op.id, BUILDER_AGENT_TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      })));
      const security = new SecurityLayer(appDir, "common");
      security.addAllowedPath(appDir, sessionId || op.id);
      registerToolDispatcherForOp(op.id, makeChatToolDispatcher({
        tools: BUILDER_AGENT_TOOLS,
        security,
        sessionId: sessionId || op.id,
        opId: op.id,
      }));
    }

    registerAdapterForOp(op.id, () => createAppBuildAdapter({
      strategy,
      provider,
      appName,
      appDir,
      appUrl,
      prompt: cliPrompt,
      systemPrompt: personaPrompt,
      sessionId: sessionId || undefined,
    }));

    canonicalLoopEntry(op, sessionId ? { sessionId } : {});

    return {
      content:
        `App build queued — op ${op.id} (strategy=${strategy}, provider=${provider}, lane=build).\n` +
        `Running in background — you can keep responding to the user. ` +
        `The user will see a notification when APP_READY emits with the URL.\n` +
        `Cancel: op_kill(op_id="${op.id}")`,
      metadata: {
        chip: {
          kind: "op-submitted",
          label: `Building ${appName}`,
          opId: op.id,
        },
      },
    };
  },
};

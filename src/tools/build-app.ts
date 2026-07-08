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
import { join, resolve } from "node:path";
import { getSetting } from "../settings.js";
import { workspacePath, workspaceRoot } from "../config.js";
import type { ToolDefinition } from "../types.js";
import { PROVIDERS } from "../providers/registry.js";
import {
  renderPerBuildContext,
  renderPersonaPrompt,
  listAssetsDir,
  readUpdateContextFiles,
  renderBuilderPrompt,
} from "./render-builder-prompt.js";
import { AgentTemplateStore, type AgentExecStrategy } from "../agent-store/index.js";
import { seedAppTemplate } from "./app-tools/app-template.js";
import {
  gatherPriorBuildSessions,
  renderPriorBuildBlock,
  evidenceImagesFromPriorSessions,
} from "./build-session-context.js";
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
import { SecurityLayer } from "../security/index.js";
import { loadFileAccessModeAtLeast } from "../security/security-config.js";
import type { Op, OpVisibility } from "../ops/types.js";
import { readTool, writeTool, editTool } from "./file-tools.js";
import { bashTool } from "./shell-tools.js";
import { globTool } from "./glob-tool.js";
import { connectorCreateTool } from "./connector-tools.js";
import { processStartTool, processStatusTool, processKillTool } from "./process-tools-defs.js";
import { appServeBackendTool, appServeFrontendTool } from "./dev-server-tools.js";
import { classifyAppTier, tierLabel, type AppTier } from "./app-tier.js";

/** Tool defs the in-canonical-sub-agent strategy hands to the agent. Mirrors
 *  the app-builder template's allowedTools verbatim. */
const BUILDER_AGENT_TOOLS = [writeTool, readTool, editTool, bashTool, globTool, connectorCreateTool];

/**
 * Tools for the in-canonical builder, by tier. Real-build tiers (full-stack,
 * compiled-native) additionally get the process_* tools so the agent can run a
 * long-lived dev server or a multi-minute compile without blocking the turn on
 * bash. No new security surface: the agent already has bash (arbitrary shell),
 * so process_start can't reach anything bash couldn't.
 */
export function builderToolsForTier(tier: AppTier): typeof BUILDER_AGENT_TOOLS {
  if (tier === "quick-html") return BUILDER_AGENT_TOOLS;
  const withProcess = [...BUILDER_AGENT_TOOLS, processStartTool, processStatusTool, processKillTool];
  // Full-stack and frontend-spa both get the turnkey dev-server primitives: a
  // real backend (app_serve_backend, connector-wired) and/or a build-step
  // frontend dev server (app_serve_frontend, reverse-proxied at /apps/<id>/).
  // A frontend-spa app can also need a backend; a full-stack app can serve a
  // build-step frontend — so both tiers get both tools.
  if (tier === "full-stack" || tier === "frontend-spa") {
    return [...withProcess, appServeBackendTool, appServeFrontendTool];
  }
  return withProcess;
}

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
    // Tests inject a custom settingsPath; honor that raw read. The default
    // (no override) goes through the canonical cached settings reader so the
    // file is parsed once, coherently, across the whole process.
    if (opts.settingsPath) {
      if (existsSync(opts.settingsPath)) {
        const s = JSON.parse(readFileSync(opts.settingsPath, "utf-8"));
        if (typeof s.provider === "string" && s.provider.length > 0) return s.provider;
      }
    } else {
      const provider = getSetting<string>("provider");
      if (typeof provider === "string" && provider.length > 0) return provider;
    }
  } catch { /* fall through */ }
  return "anthropic";
}

/**
 * Resolve the model the build subprocess should use. The Codex CLI's own
 * default is a retired model (gpt-5.3-codex), so build_app must pass one
 * explicitly: the chat's runtime model when it's valid for the provider,
 * else the provider's registry default.
 */
export function resolveBuildModel(provider: string, runtimeModel: string | undefined): string | undefined {
  const meta = PROVIDERS[provider as keyof typeof PROVIDERS];
  if (runtimeModel && meta?.models.includes(runtimeModel)) return runtimeModel;
  return meta?.defaultModel || undefined;
}

export function resolveBuildStrategy(provider: string): AgentExecStrategy {
  const template = AgentTemplateStore.getInstance().get("app-builder");
  const strategy = template?.providerStrategy ?? {};
  return (strategy[provider] ?? strategy.default ?? "in-canonical-sub-agent");
}

export interface CollisionCheckResult {
  /** When true, the build must NOT proceed — return the error to the agent. */
  blocked: boolean;
  /** When true, the build is a deliberate update of an existing app. */
  isUpdate: boolean;
  /** Agent-facing error message when blocked. */
  errorMessage?: string;
}

/**
 * Guard against the silent-overwrite collision: two builds picking the same
 * slug (e.g. both Codex and Grok choosing `graphing-calculator`) would let
 * the second one stomp the first because `isUpdate` used to be inferred from
 * directory existence alone. Now `isUpdate` is an explicit caller intent
 * (the `update` arg), and a collision without that flag is refused with a
 * message that tells the LLM exactly how to disambiguate.
 *
 * Pure helper so the decision logic is unit-testable without queuing an op.
 */
export function checkBuildCollision(
  appDir: string,
  appName: string,
  updateFlag: boolean,
): CollisionCheckResult {
  const exists = existsSync(resolve(appDir, "index.html"));
  if (!exists) return { blocked: false, isUpdate: false };
  if (updateFlag) return { blocked: false, isUpdate: true };
  return {
    blocked: true,
    isUpdate: false,
    errorMessage:
      `App "${appName}" already exists at workspace/apps/${appName}/index.html. ` +
      `Refusing to overwrite silently. Pick one:\n` +
      `  • Modifying the existing app (user said "make it green", "update X", "add Y to it") ` +
      `→ call build_app again with update: true.\n` +
      `  • New, separate app (different variant or different brief) ` +
      `→ pick a different name (e.g. "${appName}-v2", "${appName}-green").`,
  };
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
      update: { type: "boolean", description: "Set true ONLY when modifying an EXISTING app under the same name — e.g. user said 'make it green', 'update X', 'add Y to it'. Omit/false for a new app; if the name collides, the tool refuses rather than overwrite. For a new variant on the same theme, pick a different name instead." },
    },
    required: ["name", "prompt"],
  },
  async execute(args) {
    const appName = String(args.name || "app").replace(/[^a-zA-Z0-9_-]/g, "-");
    // Some models occasionally emit `description` instead of `prompt`. Live
    // failure 2026-05-14 on Anthropic Opus 4.7 — prompt missing, description
    // present. Schema docs the right key; alias keeps back-compat.
    const prompt = String(args.prompt || args.description || "");
    const tier = classifyAppTier(prompt);
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
    const runtimeModel = args._runtimeModel ? String(args._runtimeModel) : undefined;
    const buildModel = resolveBuildModel(provider, runtimeModel);

    const appDir = workspacePath("apps", appName);
    const port = process.env.LAX_PORT ?? "7007";
    const appUrl = `http://127.0.0.1:${port}/apps/${appName}/index.html`;

    // Collision guard before mkdir so a refused build leaves no empty dir
    // behind. Caller must pass update:true to modify an existing app.
    const collision = checkBuildCollision(appDir, appName, args.update === true);
    if (collision.blocked) {
      return { content: collision.errorMessage ?? "App name collision.", isError: true };
    }
    const isUpdate = collision.isUpdate;

    mkdirSync(appDir, { recursive: true });
    // For NEW builds, drop a working index.html + AGENTS.md so the agent
    // edits a starter (correct CSP, viewport meta, neutral palette) rather
    // than generating from scratch — cuts weak-model regressions where a
    // first turn tries to load Tailwind CDN and lands an unstyled page.
    // Idempotent on update flows (existing files are preserved).
    // EXCEPT the real-build tiers (compiled-native, frontend-spa): the starter
    // is a static card/hero "dashboard" and the builder is told to edit it in
    // place — which is exactly how the model FAKES a real build (a Rust render
    // wrapped in dashboard chrome; a Vite app faked as a static page that merely
    // describes Vite). Skipping the seed removes the fakeable artifact so the
    // model must produce the real thing (its toolchain output / a real dev
    // server). One rule, both real-build tiers — a class fix, not a per-tier one.
    const realBuildTier = tier === "compiled-native" || tier === "frontend-spa";
    if (!isUpdate && !realBuildTier) seedAppTemplate(appDir, appName);

    // Updates carry the prior session's spine (original brief + last build's
    // final report + any verify-gate rejection) ahead of the file snapshot —
    // the fixer remembers building the app instead of re-diagnosing cold.
    const priorSessions = isUpdate ? gatherPriorBuildSessions(appUrl, APP_BUILD_OP_TYPE) : [];
    const priorBlock = renderPriorBuildBlock(priorSessions);
    // Screenshot evidence from a gate-rejected prior build rides the seeded
    // message as image refs — the in-canonical fixer SEES the broken render
    // instead of imagining it from prose. filePath refs keep op_messages
    // small; the Anthropic-CLI strategy gets the on-disk path hint instead.
    const evidenceImages = evidenceImagesFromPriorSessions(priorSessions);
    const contextFiles = isUpdate
      ? [...(priorBlock ? [priorBlock] : []), ...readUpdateContextFiles(appDir)]
      : [];
    const assetFiles = listAssetsDir(appDir);

    const perBuildContext = renderPerBuildContext({
      appName, prompt, appDir, appUrl, isUpdate, contextFiles, assetFiles, tier,
    });
    // cli-subprocess path expects the full legacy prompt (per-build context
    // + WEBSITE_RULES_FRAGMENT when applicable). Composed via the legacy
    // renderer so the subprocess gets a byte-identical prompt to pre-migration.
    const cliPrompt = renderBuilderPrompt({
      appName, prompt, appDir, appUrl, isUpdate, contextFiles, assetFiles, tier,
    });

    const tierCriteria = tier === "full-stack"
      ? [`a real backend is running (started via app_serve_backend, which verifies it bound its port) and index.html reaches it through its dev connector`]
      : tier === "frontend-spa"
        ? [`a REAL framework project was scaffolded (package.json + framework config + src/) and a live dev server is running via app_serve_frontend (it verifies the port bound) — NOT a static index.html that mimics the framework`]
        : tier === "compiled-native"
          ? [`the real toolchain was actually run (not a browser reimplementation); index.html shows the program's real output`]
          : [];
    const contextPack = await buildContextPack({
      description: `Build ${tierLabel(tier)} "${appName}" (${strategy})`,
      successCriteria: [`APP_READY: <url> emitted`, `index.html written to ${appDir}`, ...tierCriteria],
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
      appUrl,
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
      content: {
        text: perBuildContext,
        ...(evidenceImages.length > 0 ? { images: evidenceImages } : {}),
      },
      createdAt: new Date().toISOString(),
    });

    if (strategy === "in-canonical-sub-agent") {
      const builderTools = builderToolsForTier(tier);
      registerToolsForOp(op.id, builderTools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      })));
      // Anchor the sandbox at the WORKSPACE ROOT (the same value the main chat
      // path uses), NOT appDir — evaluateFileAccess resolves relative agent
      // paths as `resolve(workspace, "..", rawPath)`, so passing appDir made a
      // relative `workspace/apps/<name>/index.html` write resolve to a phantom
      // doubled path and get blocked. Writes stay confined to appDir via
      // addAllowedPath; only the relative-path anchor is corrected.
      const security = new SecurityLayer(workspaceRoot(), loadFileAccessModeAtLeast("common"));
      security.addAllowedPath(appDir, sessionId || op.id);
      registerToolDispatcherForOp(op.id, makeChatToolDispatcher({
        tools: builderTools,
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
      brief: prompt,
      systemPrompt: personaPrompt,
      sessionId: sessionId || undefined,
      model: buildModel,
      tier,
    }));

    canonicalLoopEntry(op, sessionId ? { sessionId } : {});

    return {
      content:
        `App build queued — op ${op.id} (strategy=${strategy}, provider=${provider}, lane=build).\n` +
        `This op owns the ENTIRE build and will deliver the result to the user itself when done. ` +
        `Do NOT build it yourself this turn (no bash/cargo, no write/edit of source, no send_image) — that duplicates the work. ` +
        `Do NOT open the app in the browser tool to "check" it — the build op already loads, clicks, and screenshots the app HEADLESSLY before reporting done (the [verify] lines are the receipt); a browser call just pops a pointless Chrome window at the user. ` +
        `Just briefly tell the user it's building; they'll see it when APP_READY emits.\n` +
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

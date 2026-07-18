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
import { join } from "node:path";
import { getSetting } from "../settings.js";
import { workspacePath } from "../config.js";
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
  appendOpMessage,
} from "../canonical-loop/index.js";
import type { Op, OpVisibility } from "../ops/types.js";
import { resolveAppTier, tierLabel, formatClarify, type AppTier } from "./app-tier.js";
import { checkBuildCollision } from "./build-app-collision.js";
import { selectDesignBrief } from "./design-brief.js";
import { recordDesignSpec } from "../canonical-loop/index.js";
import { registerAppBuildRuntime } from "./build-app-runtime.js";

export const APP_BUILD_OP_TYPE = "app_build";
export const BUILD_APP_BUDGET = { maxIterations: 50, maxWallTimeMs: 0 } as const;

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
 *
 * The membership check is only meaningful for providers that HAVE a static
 * catalog. `local` and `ollama-cloud` populate `models` dynamically from the
 * src/local-runtimes/ discovery sweep and ship an empty static list by design
 * (see the `models` field docs in providers/registry.ts) — so for them
 * `includes()` is unconditionally false. Treating that as "invalid model" made
 * every local build silently fall back to PROVIDERS.local.defaultModel
 * ("qwen2:7b"), discarding the model the user actually picked. That's the
 * opposite of this function's documented contract ("resolveBuildModel honors
 * whatever's selected" — registry.ts, on the coding-specialist models).
 *
 * An EMPTY static list therefore means "catalog is dynamic, membership is
 * unprovable, trust the selection" — never "fall back to the default". Keyed
 * off list emptiness rather than a `provider === "local"` special-case so a
 * future dynamic-catalog provider inherits the right behavior for free.
 *
 * Concretely, the qwen2:7b fallback was the worst reachable outcome: it's the
 * model this codebase documents as THE exemplar of silently returning empty
 * when sent tools, so the builder would narrate instead of writing files and
 * die on artifact_missing — while the user's actual pick may have been fine.
 * It also mis-routed the endpoint (resolve-target looks the model up in the
 * runtime cache; a phantom model finds nothing and falls back to the Ollama
 * URL) and mis-sized the context window.
 */
export function resolveBuildModel(provider: string, runtimeModel: string | undefined): string | undefined {
  const meta = PROVIDERS[provider as keyof typeof PROVIDERS];
  if (!meta) return undefined;
  if (!runtimeModel) return meta.defaultModel || undefined;
  if (meta.models.length === 0) return runtimeModel;
  if (meta.models.includes(runtimeModel)) return runtimeModel;
  return meta.defaultModel || undefined;
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
      backend: { type: "string", enum: ["codex", "claude", "auto"], description: "Which model builds the app. 'auto' (default) matches your active provider. 'codex' = GPT, 'claude' = Claude. All build over HTTP (no CLI subprocess) unless a provider is explicitly pinned to cli-subprocess in the app-builder template." },
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
    const resolved = await resolveAppTier(prompt);
    // Materially-ambiguous brief ("a mega computer") → surface the scoped
    // question instead of blind-building; harness backstop for tool-shy models.
    if (typeof resolved !== "string") return { content: formatClarify(resolved), isError: false };
    const tier = resolved;
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
      budget: BUILD_APP_BUDGET,
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

    const personaPrompt = renderPersonaPrompt();
    op.runtimeDescriptor = {
      kind: "app-build",
      strategy,
      provider,
      appName,
      appDir,
      appUrl,
      prompt: cliPrompt,
      brief: prompt,
      systemPrompt: personaPrompt,
      adapterSessionId: sessionId || undefined,
      model: buildModel,
      tier,
    };

    const runtime = registerAppBuildRuntime(op, op.runtimeDescriptor);
    if (!runtime.registered) {
      return {
        content: runtime.errorMessage ?? "Product Build owns this project.",
        isError: true,
      };
    }

    if (sessionId) trackOpForSession(op.id, sessionId, op.task);

    // Stash the mandated design spec so the vision judges score token adherence
    // (feeds the design-verify refine nudge). Create-only, like the prompt brief.
    if (!isUpdate) recordDesignSpec(op.id, selectDesignBrief(prompt).brief);

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

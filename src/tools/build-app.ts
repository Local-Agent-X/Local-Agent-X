/**
 * build_app — the start of an app the chat builds itself.
 *
 * It sizes the request, sets up the app's folder and returns the build brief;
 * the chat then writes the app in the conversation and has it checked
 * (app-check-tool.ts). Until 2026-11-27 it handed the build to a background
 * `app_build` op and told the chat not to build; the owner's call was that a
 * chat builds what it is asked for, as a second chat is always free to talk in.
 * The helpers below (provider, model, strategy) and the op runtime
 * (build-app-runtime.ts) now serve only an `app_build` op restored from disk.
 *
 * What an app_build op was:
 * Strategy split (from the app-builder agent template's providerStrategy):
 *   - in-canonical-sub-agent — the default for every provider: the
 *     provider's HTTP adapter drives the turn_loop with
 *     write/read/edit/bash/glob tools.
 *   - cli-subprocess — only for a provider the template pins to it: the build
 *     runs the codex CLI for codex, the claude CLI otherwise, on the host,
 *     outside the cage; cancel kills the subprocess tree via the adapter's
 *     AbortController. It needs developer_mode (build-app-cli-gate.ts),
 *     checked here before any model call and again by the adapter right
 *     before it spawns.
 *
 * This tool is the collapse of the legacy build_app + build_app_canonical.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSetting } from "../settings.js";
import { workspacePath } from "../config.js";
import type { ToolDefinition } from "../types.js";
import { PROVIDERS } from "../providers/registry.js";
import { APP_CHAT_TOOL_HINT, FULL_STACK_SOURCE_ROOTS, renderPerBuildContext, listAssetsDir } from "./render-builder-prompt.js";
import { AgentTemplateStore, type AgentExecStrategy } from "../agent-store/index.js";
import { appEnvironmentNotes, seedAppTemplate } from "./app-tools/app-template.js";
import { applyProjectKit } from "../app-scaffold/project-kit.js";
import { resolveAppTier, tierLabel, formatClarify, type AppTier } from "./app-tier.js";
import { checkBuildCollision } from "./build-app-collision.js";
import { selectDesignBrief } from "./design-brief.js";
import { markDesignDelivered } from "./app-tools/design-gate.js";
import { OP_TYPE } from "../ops/op-types.js";
import { sessionIdOf } from "../tool-execution/internal-args.js";
import { selfPort } from "../security/layer/loopback-grant.js";

export const APP_BUILD_OP_TYPE = OP_TYPE.appBuild;
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

/** What a build started with, kept beside the app so its check (app-check-tool.ts)
 *  judges it against what was asked, in a later turn or after a restart. */
export interface AppBuildBrief {
  prompt: string;
  tier: AppTier;
  /** The build creates the app; false when it changes one that exists. */
  newBuild: boolean;
  /** The design system the build was given (a new app only). */
  designSpec?: string;
}

const BRIEF_FILE = join(".lax-build", "brief.json");

export function writeAppBuildBrief(appDir: string, brief: AppBuildBrief): void {
  mkdirSync(join(appDir, ".lax-build"), { recursive: true });
  writeFileSync(join(appDir, BRIEF_FILE), JSON.stringify(brief, null, 2) + "\n");
}

/** The brief the app's last build started with; null for an app written without build_app. */
export function readAppBuildBrief(appDir: string): AppBuildBrief | null {
  try {
    const raw = JSON.parse(readFileSync(join(appDir, BRIEF_FILE), "utf-8")) as Partial<AppBuildBrief>;
    if (typeof raw.prompt !== "string" || typeof raw.tier !== "string") return null;
    return { prompt: raw.prompt, tier: raw.tier as AppTier, newBuild: raw.newBuild === true, ...(typeof raw.designSpec === "string" ? { designSpec: raw.designSpec } : {}) };
  } catch {
    // No brief, or one that does not parse: the app is checked without one.
    return null;
  }
}

/** What the chat does after the brief: build it here, then have it checked. */
function buildItHere(appName: string, appDir: string, tier: AppTier): string {
  // The serving and process tools the larger sizes call are not in every
  // chat's tool list from the start.
  const serving = tier === "quick-html" ? [] : [
    "If a tool the rules above name (app_serve_frontend, app_serve_backend, process_start, process_status, process_kill) is not in your tool list, load it with tool_search first.",
  ];
  return [
    "",
    "BUILD IT YOURSELF, NOW, IN THIS CONVERSATION. No worker is building this: you are.",
    ...serving,
    `1. Write the files under ${appDir}/ with your own write and edit tools (and the shell, where the size above calls for a real toolchain or server).`,
    `2. When it is built, call app_check({"name": "${appName}"}). It loads the app headlessly, clicks its main action, has the result judged against this brief, and runs the structure check. Do not open the app in the browser tool to check it yourself.`,
    "3. Fix what app_check reports and call it again. Give the user the app's link only once app_check returns it.",
  ].join("\n");
}

export const buildAppTool: ToolDefinition = {
  name: "build_app",
  compactDescription: "Start a web app in workspace/apps/: sets up its folder and returns the build brief. You then write the app yourself and call app_check. For NEW apps and LARGE rewrites; small edits use read + edit.",
  description:
    "Start building a web app in workspace/apps/. It sizes the request, sets up the app's folder (a starter page, or the structure kit for a project), " +
    "and returns the build brief: where the files go, the rules for this size of app, and the design system. You then build the app yourself in this " +
    "conversation with write/edit (and the shell where needed), and call app_check when it is built; app_check loads and judges it and returns the link. " +
    "Use this for NEW apps and LARGE rewrites. For small edits to existing apps, prefer read + edit directly. " +
    APP_CHAT_TOOL_HINT,
  describeCall: (args) => `Start app: ${String(args.name || "")}`,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "App directory name (e.g. 'trading-bot', 'todo-app')" },
      prompt: { type: "string", description: "Build brief — what to make, target features, styling notes, behavior. Be specific." },
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

    const appDir = workspacePath("apps", appName);
    const appUrl = `http://127.0.0.1:${selfPort()}/apps/${appName}/index.html`;

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
    // A project-shaped build starts with the structure kit (src/app-scaffold):
    // the full-stack and compiled tiers here, the Vite tier in its scaffold
    // step, Product Build in its materializer. The quick single-page tier has
    // no modules to check and keeps the starter's own AGENTS.md. The kit goes
    // in before the starter so a full-stack app's AGENTS.md is the kit's, with
    // the served page's CSP notes as its Environment section.
    if (!isUpdate && (tier === "full-stack" || tier === "compiled-native")) {
      applyProjectKit(appDir, tier === "full-stack"
        ? { projectName: appName, environmentNotes: appEnvironmentNotes(), sourceRoots: [...FULL_STACK_SOURCE_ROOTS] }
        : { projectName: appName });
    }
    if (!isUpdate && !realBuildTier) seedAppTemplate(appDir, appName);

    // The brief is the builder's own: the rules for this size of app and the
    // design system, which the chat now follows itself. An update names no
    // files: the chat reads what it changes (the brief's update rules say so).
    const brief = renderPerBuildContext({
      appName, prompt, appDir, appUrl, isUpdate, contextFiles: [], assetFiles: listAssetsDir(appDir), tier,
    });
    // The brief carries the design system, so the app's UI writes are not held for it.
    markDesignDelivered(sessionIdOf(args), appName);
    writeAppBuildBrief(appDir, {
      prompt, tier, newBuild: !isUpdate,
      ...(isUpdate ? {} : { designSpec: selectDesignBrief(prompt).brief }),
    });

    return {
      content: `${isUpdate ? "Update" : "New app"} "${appName}" (${tierLabel(tier)}) is set up at ${appDir}.\n\n${brief}\n${buildItHere(appName, appDir, tier)}`,
      metadata: { app: appName, tier, update: isUpdate },
    };
  },
};

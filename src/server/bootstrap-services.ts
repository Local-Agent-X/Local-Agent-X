import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { SecurityLayer } from "../security.js";
import { loadToolPolicy } from "../tool-policy.js";
import { SessionStore, MemoryIndex, MemoryManager, ensurePersonalityFiles } from "../memory.js";
import { SecretsStore } from "../secrets.js";
import { AgentSync } from "../sync.js";
import { RBACManager } from "../rbac.js";
import { setBrowserAuthContext } from "../browser.js";
import { CronService } from "../cron-service.js";
import { IntegrationRegistry } from "../integrations.js";
import { setServerPort } from "../server-utils.js";
import type { LAXConfig } from "../types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("server.bootstrap-services");

export interface BootstrappedServices {
  security: SecurityLayer;
  publicDir: string;
  dataDir: string;
  toolPolicy: ReturnType<typeof loadToolPolicy>;
  rbac: RBACManager;
  agentSync: AgentSync;
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
  memoryManager: MemoryManager;
  secretsStore: SecretsStore;
  cronService: CronService;
  integrations: IntegrationRegistry;
  loadSavedSettings: () => Record<string, unknown>;
}

/**
 * Initialize (or re-initialize) the embedding provider. Idempotent — safe to
 * call multiple times. Extracted from inline bootstrap code so it can be
 * re-run when the source state changes (e.g. Ollama finishes pulling a model
 * AFTER server boot, or the user changes embeddingModel in settings).
 *
 * Caching-at-boot was the visible failure on 2026-05-17 fresh install: the
 * server boots immediately after the .app launches, and Ollama's pull may
 * still be in flight (~670MB takes a minute). The embedding provider was
 * stored in a degraded state and never re-checked — memory-recall stayed
 * keyword-only until the user manually restarted the app.
 *
 * Returns the resolved provider and a `degraded` flag (true if the chosen
 * provider couldn't be backed by its preferred model — e.g. ollama unreachable
 * or model still missing).
 */
export async function initOrRefreshEmbeddingProvider(deps: {
  config: LAXConfig;
  dataDir: string;
  secretsStore: SecretsStore;
  memoryIndex: MemoryIndex;
}): Promise<{ providerName: string; model: string; degraded: boolean }> {
  const { config, dataDir, secretsStore, memoryIndex } = deps;
  try {
    const { createEmbeddingProvider } = await import("../embedding-providers.js");
    const sp = join(dataDir, "settings.json");
    const settings = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf-8")) : {};
    const embProvider = settings.embeddingProvider || "ollama";
    const embModel = settings.embeddingModel || undefined;

    let degraded = false;

    if (embProvider === "ollama") {
      const targetModel = embModel || "mxbai-embed-large";
      const fallbackModel = "nomic-embed-text";
      try {
        const ollamaUrl = (settings.ollamaUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
        const ping = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (ping?.ok) {
          const tags = await ping.json() as { models?: Array<{ name: string }> };
          const installed = (tags.models || []).map(m => m.name.replace(/:latest$/, ""));
          if (!installed.includes(targetModel)) {
            logger.info(`[memory] Model "${targetModel}" not found in Ollama. Pulling... (this may take a minute on first run)`);
            try {
              const pullRes = await fetch(`${ollamaUrl}/api/pull`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: targetModel, stream: false }),
                signal: AbortSignal.timeout(300_000),
              });
              if (pullRes.ok) {
                logger.info(`[memory] Pulled ${targetModel} successfully`);
              } else {
                degraded = true;
                logger.warn(`[memory] Failed to pull ${targetModel} — trying ${fallbackModel}`);
                if (!installed.includes(fallbackModel)) {
                  await fetch(`${ollamaUrl}/api/pull`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: fallbackModel, stream: false }),
                    signal: AbortSignal.timeout(120_000),
                  });
                  logger.info(`[memory] Pulled ${fallbackModel} as fallback`);
                }
              }
            } catch (pullErr) {
              degraded = true;
              logger.warn(`[memory] Model pull failed: ${(pullErr as Error).message}`);
              if (!installed.includes(fallbackModel)) {
                try {
                  await fetch(`${ollamaUrl}/api/pull`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: fallbackModel, stream: false }),
                    signal: AbortSignal.timeout(120_000),
                  });
                  logger.info(`[memory] Pulled ${fallbackModel} as fallback`);
                } catch {}
              }
            }
          }
        } else {
          degraded = true;
          logger.warn(`[memory] Ollama not reachable at ${ollamaUrl} — embedding provider will be degraded until ollama is up. Call /api/memory/reinit to retry.`);
        }
      } catch (ollamaErr) {
        degraded = true;
        logger.warn(`[memory] Ollama check failed: ${(ollamaErr as Error).message}`);
      }
    }

    let apiKey: string | undefined;
    if (embProvider === "openai") apiKey = secretsStore.get("OPENAI_API_KEY") || config.openaiApiKey;
    else if (embProvider === "gemini") apiKey = secretsStore.get("GEMINI_API_KEY");
    const provider = createEmbeddingProvider({ provider: embProvider, apiKey, model: embModel });
    memoryIndex.setEmbeddingProvider(provider);
    logger.info(`[memory] Embedding provider: ${provider.name}/${provider.model} (${provider.dimensions}d)${degraded ? " [degraded]" : ""}`);

    if (provider.name !== "local") {
      void provider.embed("warmup").catch(() => {});
      logger.info(`[memory] Embedding pre-warm fired (${provider.name})`);
    }
    return { providerName: provider.name, model: provider.model, degraded };
  } catch (e) {
    logger.warn(`[memory] Embedding provider not available: ${(e as Error).message} — keyword search only`);
    return { providerName: "none", model: "", degraded: true };
  }
}

export async function bootstrapServices(config: LAXConfig): Promise<BootstrappedServices> {
  setServerPort(String(config.port || 7007));
  SecurityLayer._selfPort = String(config.port || 7007);
  const security = new SecurityLayer(config.workspace);
  import("../hooks/hook-engine.js").then(({ initHookEngine }) => initHookEngine(security)).catch(() => {});
  // Run the legacy ~/.lax/skills/ → ~/.lax/protocols/imported/ migration once
  // and warm the bundled-protocol cache. Async + .catch so a parse failure
  // never blocks server boot.
  import("../protocols/loader.js").then(({ bootProtocolsLayer, loadBundledProtocols }) => {
    bootProtocolsLayer();
    const n = loadBundledProtocols().length;
    if (n > 0) logger.info(`[protocols] ${n} bundled protocol(s) loaded`);
  }).catch((e) => logger.warn(`[protocols] init failed: ${(e as Error).message}`));
  const publicDir = join(import.meta.dirname || ".", "..", "..", "public");
  const dataDir = join(homedir(), ".lax");
  for (const d of ["apps", "images", "videos", "missions"]) mkdirSync(join(resolve(config.workspace), d), { recursive: true });
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const toolPolicy = loadToolPolicy(dataDir);
  const rbac = new RBACManager(dataDir, config.authToken);
  setBrowserAuthContext(config.authToken, String(config.port));
  // Wire SAX's shared pre-dispatch chain into AriKernel's tool executors so
  // any direct executor invocation (outside the chat-path's no-op observer
  // setup) still hits security + tool-policy. Closes F3 in DRY-AUDIT.md.
  //
  // FAIL-CLOSED: AriKernel is a defense layer. If the gate can't wire, tool
  // calls would bypass security + policy silently — exactly the failure mode
  // a defense layer must not have. Halt boot instead so the operator notices.
  try {
    const { wireAriPreDispatch } = await import("./bootstrap-ari-gate.js");
    wireAriPreDispatch(security, toolPolicy);
  } catch (e) {
    logger.error(`[ari-gate] wire failed — refusing to boot without security gate: ${(e as Error).message}`);
    throw new Error(`AriKernel pre-dispatch gate failed to wire: ${(e as Error).message}`);
  }

  const secretsStoreRef: { value: SecretsStore | null } = { value: null };
  const agentSync = new AgentSync(dataDir, () => secretsStoreRef.value?.get("GITHUB_SYNC_TOKEN"));
  const sessionStore = new SessionStore(dataDir);
  const memoryIndex = new MemoryIndex(dataDir);
  const memoryManager = new MemoryManager(memoryIndex);
  ensurePersonalityFiles(join(dataDir, "memory"));
  const secretsStore = new SecretsStore(dataDir);
  secretsStoreRef.value = secretsStore;
  const { setSecretsStoreSingleton } = await import("../secrets.js");
  setSecretsStoreSingleton(secretsStore);

  await initOrRefreshEmbeddingProvider({ config, dataDir, secretsStore, memoryIndex });

  import("../image-tools.js").then(m => m.initImageTools?.(secretsStore)).catch(() => {});
  const cronService = new CronService(dataDir);
  const integrations = new IntegrationRegistry(dataDir);

  function loadSavedSettings() {
    try {
      const sp = join(dataDir, "settings.json");
      if (existsSync(sp)) return JSON.parse(readFileSync(sp, "utf-8"));
    } catch {} return {};
  }

  return { security, publicDir, dataDir, toolPolicy, rbac, agentSync, sessionStore, memoryIndex, memoryManager, secretsStore, cronService, integrations, loadSavedSettings };
}

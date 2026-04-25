import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { SecurityLayer } from "../security.js";
import { loadToolPolicy } from "../tool-policy.js";
import { SessionStore, MemoryIndex, ensurePersonalityFiles } from "../memory.js";
import { SecretsStore } from "../secrets.js";
import { AgentSync } from "../sync.js";
import { RBACManager } from "../rbac.js";
import { setBrowserAuthContext } from "../browser.js";
import { CronService } from "../cron-service.js";
import { IntegrationRegistry } from "../integrations.js";
import { setServerPort } from "../server-utils.js";
import type { LAXConfig } from "../types.js";

export interface BootstrappedServices {
  security: SecurityLayer;
  publicDir: string;
  dataDir: string;
  toolPolicy: ReturnType<typeof loadToolPolicy>;
  rbac: RBACManager;
  agentSync: AgentSync;
  sessionStore: SessionStore;
  memoryIndex: MemoryIndex;
  secretsStore: SecretsStore;
  cronService: CronService;
  integrations: IntegrationRegistry;
  loadSavedSettings: () => Record<string, unknown>;
}

export async function bootstrapServices(config: LAXConfig): Promise<BootstrappedServices> {
  setServerPort(String(config.port || 7007));
  SecurityLayer._selfPort = String(config.port || 7007);
  const security = new SecurityLayer(config.workspace);
  import("../hooks/hook-engine.js").then(({ initHookEngine }) => initHookEngine(security)).catch(() => {});
  import("../skills/skill-loader.js").then(({ getSkillRegistry }) => getSkillRegistry(config.workspace)).catch(() => {});
  const publicDir = join(import.meta.dirname || ".", "..", "..", "public");
  const dataDir = join(homedir(), ".lax");
  for (const d of ["apps", "images", "videos", "missions"]) mkdirSync(join(resolve(config.workspace), d), { recursive: true });
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const toolPolicy = loadToolPolicy(dataDir);
  const rbac = new RBACManager(dataDir, config.authToken);
  setBrowserAuthContext(config.authToken, String(config.port));

  const secretsStoreRef: { value: SecretsStore | null } = { value: null };
  const agentSync = new AgentSync(dataDir, () => secretsStoreRef.value?.get("GITHUB_SYNC_TOKEN"));
  const sessionStore = new SessionStore(dataDir);
  const memoryIndex = new MemoryIndex(dataDir);
  ensurePersonalityFiles(join(dataDir, "memory"));
  const secretsStore = new SecretsStore(dataDir);
  secretsStoreRef.value = secretsStore;
  const { setSecretsStoreSingleton } = await import("../secrets.js");
  setSecretsStoreSingleton(secretsStore);

  try {
    const { createEmbeddingProvider } = await import("../embedding-providers.js");
    const sp = join(dataDir, "settings.json");
    const settings = existsSync(sp) ? JSON.parse(readFileSync(sp, "utf-8")) : {};
    const embProvider = settings.embeddingProvider || "ollama";
    const embModel = settings.embeddingModel || undefined;

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
            console.log(`[memory] Model "${targetModel}" not found in Ollama. Pulling... (this may take a minute on first run)`);
            try {
              const pullRes = await fetch(`${ollamaUrl}/api/pull`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: targetModel, stream: false }),
                signal: AbortSignal.timeout(300_000),
              });
              if (pullRes.ok) {
                console.log(`[memory] Pulled ${targetModel} successfully`);
              } else {
                console.warn(`[memory] Failed to pull ${targetModel} — trying ${fallbackModel}`);
                if (!installed.includes(fallbackModel)) {
                  await fetch(`${ollamaUrl}/api/pull`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: fallbackModel, stream: false }),
                    signal: AbortSignal.timeout(120_000),
                  });
                  console.log(`[memory] Pulled ${fallbackModel} as fallback`);
                }
              }
            } catch (pullErr) {
              console.warn(`[memory] Model pull failed: ${(pullErr as Error).message}`);
              if (!installed.includes(fallbackModel)) {
                try {
                  await fetch(`${ollamaUrl}/api/pull`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: fallbackModel, stream: false }),
                    signal: AbortSignal.timeout(120_000),
                  });
                  console.log(`[memory] Pulled ${fallbackModel} as fallback`);
                } catch {}
              }
            }
          }
        }
      } catch (ollamaErr) {
        console.warn(`[memory] Ollama check failed: ${(ollamaErr as Error).message}`);
      }
    }

    let apiKey: string | undefined;
    if (embProvider === "openai") apiKey = secretsStore.get("OPENAI_API_KEY") || config.openaiApiKey;
    else if (embProvider === "gemini") apiKey = secretsStore.get("GEMINI_API_KEY");
    const provider = createEmbeddingProvider({ provider: embProvider, apiKey, model: embModel });
    memoryIndex.setEmbeddingProvider(provider);
    console.log(`[memory] Embedding provider: ${provider.name}/${provider.model} (${provider.dimensions}d)`);
  } catch (e) { console.warn(`[memory] Embedding provider not available: ${(e as Error).message} — keyword search only`); }

  import("../image-tools.js").then(m => m.initImageTools?.(secretsStore)).catch(() => {});
  const cronService = new CronService(dataDir);
  const integrations = new IntegrationRegistry(dataDir);

  function loadSavedSettings() {
    try {
      const sp = join(dataDir, "settings.json");
      if (existsSync(sp)) return JSON.parse(readFileSync(sp, "utf-8"));
    } catch {} return {};
  }

  return { security, publicDir, dataDir, toolPolicy, rbac, agentSync, sessionStore, memoryIndex, secretsStore, cronService, integrations, loadSavedSettings };
}

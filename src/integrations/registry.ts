import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CredentialRequirement, SecretAvailabilityPort } from "../credentials/requirements.js";
import { missingCredentials } from "../credentials/requirements.js";
import type { IntegrationConfig, IntegrationDeclaration, IntegrationEndpoint } from "./types.js";
import { canAuthTypeReach } from "./types.js";
import { BUILTIN_INTEGRATIONS } from "./builtins/index.js";
import { evaluateEgressForUrl } from "../security/layer/index.js";
import { isLocalOnlyMode } from "../local-only-policy.js";

/**
 * The credential the single-entry install path acts on. `secretName` is this
 * and nothing else — deriving it in exactly one place is what keeps the list
 * and the single-name readers (the install route, the Settings modal) from
 * drifting apart.
 */
function primaryCredentialName(credentials: CredentialRequirement[]): string {
  return credentials[0]?.name ?? "";
}

function withDerivedSecretName(declaration: IntegrationDeclaration): IntegrationConfig {
  return { ...declaration, secretName: primaryCredentialName(declaration.credentials) };
}

function isCredentialRequirement(value: unknown): value is CredentialRequirement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0;
}

/**
 * Credentials declared by a persisted or user-supplied config, or undefined
 * when it declares none — which is how a saved builtin says "keep the defaults".
 *
 * Configs written before the list existed carry a single `secretName`, and
 * setting it was a real feature: it points an integration at a different vault
 * entry than the builtin default. That override survives here as a rename of
 * the primary requirement, leaving the rest of the declared list untouched.
 * A partially malformed list is ignored rather than filtered, so a corrupt file
 * can never silently promote a different credential to primary.
 */
function credentialsFrom(
  saved: Partial<IntegrationConfig>,
  current: CredentialRequirement[],
): CredentialRequirement[] | undefined {
  const raw: unknown = saved.credentials;
  if (Array.isArray(raw)) {
    const list = raw.filter(isCredentialRequirement);
    if (list.length > 0 && list.length === raw.length) return list.map((c) => ({ ...c }));
  }
  const legacy = saved.secretName;
  if (typeof legacy === "string" && legacy.length > 0) {
    const [primary, ...rest] = current;
    return [primary ? { ...primary, name: legacy } : { name: legacy }, ...rest];
  }
  return undefined;
}

export class IntegrationRegistry {
  private filePath: string;
  private integrations: Map<string, IntegrationConfig> = new Map();

  /**
   * `secrets` is REQUIRED on purpose. getAgentContext() may only advertise an
   * integration whose credentials the vault actually holds, and an optional
   * port would let a mis-wired construction site silently fall back to
   * "advertise everything" — the exact dishonest behaviour this gate exists to
   * remove — while every unit test still passed. Required makes the wiring
   * compiler-enforced.
   */
  constructor(dataDir: string, private secrets: SecretAvailabilityPort) {
    this.filePath = join(dataDir, "integrations.json");
    this.load();
  }

  private load(): void {
    for (const declaration of BUILTIN_INTEGRATIONS) {
      this.integrations.set(declaration.id, withDerivedSecretName(declaration));
    }

    if (existsSync(this.filePath)) {
      try {
        const saved = JSON.parse(readFileSync(this.filePath, "utf-8"));
        if (!Array.isArray(saved)) throw new Error("Invalid integrations config");
        for (const s of saved as IntegrationConfig[]) {
          const existing = this.integrations.get(s.id);
          if (existing) {
            // Preserve built-in endpoints/auth metadata; only adopt user's installed/enabled state
            existing.installed = s.installed;
            existing.enabled = s.enabled;
            const overrides = credentialsFrom(s, existing.credentials);
            if (overrides) {
              existing.credentials = overrides;
              existing.secretName = primaryCredentialName(overrides);
            }
          } else {
            this.integrations.set(s.id, withDerivedSecretName({ ...s, credentials: credentialsFrom(s, []) ?? [] }));
          }
        }
      } catch {}
    }
  }

  private save(): void {
    const arr = Array.from(this.integrations.values());
    writeFileSync(this.filePath, JSON.stringify(arr, null, 2), { encoding: "utf-8", mode: 0o600 });
  }

  list(): IntegrationConfig[] {
    return Array.from(this.integrations.values());
  }

  get(id: string): IntegrationConfig | undefined {
    return this.integrations.get(id);
  }

  markInstalled(id: string, installed: boolean): boolean {
    const config = this.integrations.get(id);
    if (!config) return false;
    config.installed = installed;
    this.save();
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const config = this.integrations.get(id);
    if (!config) return false;
    config.enabled = enabled;
    this.save();
    return true;
  }

  addIntegration(config: IntegrationDeclaration): void {
    config.builtin = false;
    if (config.baseUrl) {
      // Delegate to the ONE canonical egress policy (private/loopback/metadata
      // IPs incl. decimal/octal/hex/IPv6 encodings + scheme check), failing
      // CLOSED. The previous bespoke string denylist missed those encodings and
      // silently swallowed a malformed-URL throw, so it failed OPEN.
      const decision = evaluateEgressForUrl(config.baseUrl);
      if (!decision.allowed) {
        throw new Error(`Integration base URL rejected (SSRF protection): ${decision.reason}`);
      }
    }
    // Accepts either shape: POST /api/integrations still sends a bare
    // secretName, and an agent authoring from getIntegrationSchema() sends a
    // credential list.
    this.integrations.set(config.id, withDerivedSecretName({ ...config, credentials: credentialsFrom(config, []) ?? [] }));
    this.save();
  }

  removeIntegration(id: string): boolean {
    const config = this.integrations.get(id);
    if (!config || config.builtin) return false;
    this.integrations.delete(id);
    this.save();
    return true;
  }

  updateIntegration(id: string, updates: Partial<IntegrationConfig>): boolean {
    const config = this.integrations.get(id);
    if (!config) return false;
    // Whitelist updatable fields — prevent overwriting credentials, baseUrl, builtin, endpoints
    const safeFields = ["enabled", "installed", "name", "description", "icon", "category"] as const;
    for (const field of safeFields) {
      if (field in updates) {
        (config as any)[field] = (updates as any)[field];
      }
    }
    this.save();
    return true;
  }

  /**
   * The installed+enabled integrations the model can HONESTLY be told about,
   * each paired with the endpoints its declared auth can actually reach.
   *
   * Two dishonest advertisements are dropped here: an integration whose
   * credentials are not in the vault (every call would 401), and an endpoint
   * needing a user-context grant the declared auth type cannot produce. An
   * integration left with no reachable endpoint is dropped entirely — a heading
   * with an empty endpoint list teaches the model nothing.
   */
  private advertisable(): Array<{ integration: IntegrationConfig; endpoints: IntegrationEndpoint[] }> {
    return Array.from(this.integrations.values())
      .filter(i => i.installed && i.enabled)
      .map(integration => ({
        integration,
        endpoints: integration.endpoints.filter(ep => canAuthTypeReach(integration.authType, ep)),
      }))
      .filter(({ integration, endpoints }) =>
        endpoints.length > 0 && missingCredentials(integration.credentials, this.secrets).length === 0);
  }

  getAgentContext(): string {
    if (isLocalOnlyMode()) return "";
    const installed = this.advertisable();
    if (installed.length === 0) return "";

    let ctx = "\n## Connected API Integrations\n";
    ctx += "These APIs are configured and ready to use via the http_request tool.\n";
    ctx += "Use the secret name as {{SECRET_NAME}} in Authorization headers.\n\n";

    for (const { integration: i, endpoints } of installed) {
      ctx += `### ${i.icon} ${i.name} (${i.id})\n`;
      ctx += `Base URL: ${i.baseUrl}\n`;
      ctx += `Auth: ${i.credentials.map(c => `{{${c.name}}}`).join(", ")} as ${i.authType === "bearer_token" || i.authType === "bot_token" ? "Bearer token" : i.authType}\n`;
      if (i.headers && Object.keys(i.headers).length > 0) {
        ctx += `Extra headers: ${JSON.stringify(i.headers)}\n`;
      }
      ctx += `Endpoints:\n`;
      for (const ep of endpoints) {
        ctx += `- ${ep.method} ${ep.path} — ${ep.description}\n`;
      }
      ctx += "\n";
    }

    return ctx;
  }

  static getIntegrationSchema(): string {
    return JSON.stringify({
      id: "unique-slug",
      name: "Service Name",
      icon: "emoji",
      description: "What this API does",
      authType: "api_key | bearer_token | oauth2 | bot_token",
      authInstructions: "Step-by-step instructions to get credentials",
      baseUrl: "https://api.example.com",
      docsUrl: "https://docs.example.com",
      credentials: [{ name: "SERVICE_API_KEY", description: "What this value is and where to get it" }],
      scopes: ["optional", "oauth", "scopes"],
      endpoints: [
        { name: "Action Name", method: "GET", path: "/endpoint", description: "What it does", params: {} }
      ],
      headers: {},
      enabled: true,
      installed: false,
      builtin: false,
    }, null, 2);
  }
}

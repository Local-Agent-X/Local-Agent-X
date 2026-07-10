import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationConfig } from "./types.js";
import { BUILTIN_INTEGRATIONS } from "./builtins/index.js";
import { evaluateEgressForUrl } from "../security/network-policy.js";
import { isLocalOnlyMode } from "../local-only-policy.js";

export class IntegrationRegistry {
  private filePath: string;
  private integrations: Map<string, IntegrationConfig> = new Map();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "integrations.json");
    this.load();
  }

  private load(): void {
    for (const config of BUILTIN_INTEGRATIONS) {
      this.integrations.set(config.id, { ...config });
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
            if (s.secretName) existing.secretName = s.secretName;
          } else {
            this.integrations.set(s.id, s);
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

  addIntegration(config: IntegrationConfig): void {
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
    this.integrations.set(config.id, config);
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
    // Whitelist updatable fields — prevent overwriting secretName, baseUrl, builtin, endpoints
    const safeFields = ["enabled", "installed", "name", "description", "icon", "category"] as const;
    for (const field of safeFields) {
      if (field in updates) {
        (config as any)[field] = (updates as any)[field];
      }
    }
    this.save();
    return true;
  }

  getAgentContext(): string {
    if (isLocalOnlyMode()) return "";
    const installed = Array.from(this.integrations.values()).filter(i => i.installed && i.enabled);
    if (installed.length === 0) return "";

    let ctx = "\n## Connected API Integrations\n";
    ctx += "These APIs are configured and ready to use via the http_request tool.\n";
    ctx += "Use the secret name as {{SECRET_NAME}} in Authorization headers.\n\n";

    for (const i of installed) {
      ctx += `### ${i.icon} ${i.name} (${i.id})\n`;
      ctx += `Base URL: ${i.baseUrl}\n`;
      ctx += `Auth: {{${i.secretName}}} as ${i.authType === "bearer_token" || i.authType === "bot_token" ? "Bearer token" : i.authType}\n`;
      if (i.headers && Object.keys(i.headers).length > 0) {
        ctx += `Extra headers: ${JSON.stringify(i.headers)}\n`;
      }
      ctx += `Endpoints:\n`;
      for (const ep of i.endpoints) {
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
      secretName: "SERVICE_API_KEY",
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

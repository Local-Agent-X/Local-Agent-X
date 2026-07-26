import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CredentialRequirement, SecretAvailabilityPort } from "../credentials/requirements.js";
import { missingSecretCredentials } from "../credentials/requirements.js";
import type { IntegrationConfig, IntegrationDeclaration, IntegrationEndpoint } from "./types.js";
import { canAuthTypeReach, normalizeTransport, transportTools } from "./types.js";
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

/**
 * A private copy of a credential list.
 *
 * BUILTIN_INTEGRATIONS is module-level state shared by every registry in the
 * process, and a registry hands its configs straight out through get()/list().
 * Without this, `registry.get("email").credentials[1].name = …` writes THROUGH
 * into the builtin declaration and every other registry sees it — a per-user
 * override leaking process-wide. CredentialRequirement is flat (name, service,
 * description, secret, required, url are all primitives), so a per-entry spread
 * is a full copy, not a shallow one.
 *
 * This buys de-aliasing for CREDENTIALS and nothing else. `endpoints` and
 * `headers` are still handed out by reference from the builtin declaration —
 * `registry.get("github").endpoints[0].path = "/PWNED"` does leak — and that is
 * deliberately out of scope here rather than quietly claimed as fixed. The
 * invariant this function establishes is narrow: the registry never hands out a
 * reference into a builtin declaration's CREDENTIAL objects.
 *
 * withDerivedSecretName() shared the builtin's array outright, which was the
 * live leak: it was inert only while every builtin declared exactly one
 * credential, and email now declares nine. It is the funnel every config enters
 * through, so one copy there covers get(), list() and both load() branches.
 */
function cloneCredentials(credentials: CredentialRequirement[]): CredentialRequirement[] {
  return credentials.map((c) => ({ ...c }));
}

/**
 * The declared list with its primary pointed at a different vault entry.
 *
 * Renaming credentials[0] is the whole of what a saved config is allowed to say
 * about a BUILTIN's credentials — see load() — and it is also how a pre-list
 * `secretName` is honoured.
 *
 * The cloneCredentials() call here is redundant ON ITS OWN and is kept
 * deliberately. Its only caller passes `existing.credentials`, which
 * withDerivedSecretName() already privatised, so removing this clone alone is
 * unobservable through get()/list() from any input — the tail objects would be
 * shared between the array being replaced and the one replacing it, both owned
 * by the same registry, and the suite stays green. Remove BOTH clones and
 * "does not share them when a saved file renames the primary" goes red, which is
 * exactly the property being defended: a function that rebuilds a list around
 * one changed entry must not alias the list it was handed. Spreading `...rest`
 * by reference from a list the caller did not own is the bug this chunk was
 * blocked over.
 */
function withPrimaryRenamed(credentials: CredentialRequirement[], name: string): CredentialRequirement[] {
  const [primary, ...rest] = cloneCredentials(credentials);
  return [primary ? { ...primary, name } : { name }, ...rest];
}

/**
 * A declaration as the registry stores it: `secretName` derived, `endpoints`
 * guaranteed to BE an array, and `transport` guaranteed to be one this build
 * knows.
 *
 * Both fields are required/typed, but a persisted integrations.json is plain
 * JSON that nothing type-checks on the way in — a hand-edited file, or one
 * written before a field existed, can carry anything — and POST
 * /api/integrations casts an arbitrary body in after validating only
 * id/name/baseUrl. Every config enters the registry through this one funnel
 * (both load() branches for custom entries and addIntegration()), so normalising
 * HERE is why no reader needs its own guard.
 *
 * Neither is cosmetic: `.endpoints.filter()` and an unindexable `transport` each
 * threw `TypeError: Cannot read properties of undefined` out of
 * getAgentContext() — whose only caller is build-system-prompt.ts — killing the
 * whole request and every unrelated integration in the block with it.
 */
function withDerivedSecretName(declaration: IntegrationDeclaration): IntegrationConfig {
  return {
    ...declaration,
    endpoints: Array.isArray(declaration.endpoints) ? declaration.endpoints : [],
    transport: normalizeTransport(declaration.transport),
    credentials: cloneCredentials(declaration.credentials),
    secretName: primaryCredentialName(declaration.credentials),
  };
}

function isCredentialRequirement(value: unknown): value is CredentialRequirement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0;
}

/**
 * The credential list a saved config declares, or undefined when it declares
 * none OR the list is not WHOLLY well-formed.
 *
 * All-or-nothing on purpose: a partially malformed list is ignored rather than
 * filtered, so a corrupt file can never silently promote a different credential
 * to primary. Both readers below share this one rule — they differ in what they
 * do with the answer, not in what they accept.
 */
function savedCredentialList(saved: Partial<IntegrationConfig>): CredentialRequirement[] | undefined {
  const raw: unknown = saved.credentials;
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter(isCredentialRequirement);
  return list.length > 0 && list.length === raw.length ? list : undefined;
}

/**
 * The vault entry a saved config points its PRIMARY credential at, from either
 * shape a file can carry it in, or undefined when it names none.
 *
 * This is the only thing a saved config gets to say about a BUILTIN's
 * credentials — see load().
 */
function savedPrimaryName(saved: Partial<IntegrationConfig>): string | undefined {
  const list = savedCredentialList(saved);
  if (list) return list[0].name;
  const legacy = saved.secretName;
  return typeof legacy === "string" && legacy.length > 0 ? legacy : undefined;
}

/**
 * The credential list a config with NO declaration behind it carries — a custom
 * integration, whether persisted or arriving through addIntegration(). Undefined
 * when it declares none.
 *
 * A config written before the list existed carries a single `secretName`
 * instead, which becomes the one credential it declares.
 *
 * NOT used for a builtin, whose declaration is authoritative: see load().
 */
function credentialsFrom(saved: Partial<IntegrationConfig>): CredentialRequirement[] | undefined {
  const list = savedCredentialList(saved);
  if (list) return cloneCredentials(list);
  const primary = savedPrimaryName(saved);
  return primary ? [{ name: primary }] : undefined;
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
            // Credentials are NOT user state, and treating them as such is why a
            // declaration change never reached anyone: save() writes every
            // integration on any markInstalled/setEnabled/addIntegration, so a
            // user who ever connected ANYTHING has every other builtin frozen at
            // whatever it declared that day, with no migration to unfreeze it.
            // The builtin's declaration is authoritative; the one user-authored
            // fact inside a saved list is which vault entry the primary points
            // at, so that alone is re-applied.
            const renamed = savedPrimaryName(s);
            if (renamed) {
              existing.credentials = withPrimaryRenamed(existing.credentials, renamed);
              existing.secretName = primaryCredentialName(existing.credentials);
            }
          } else {
            this.integrations.set(s.id, withDerivedSecretName({ ...s, credentials: credentialsFrom(s) ?? [] }));
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
    this.integrations.set(config.id, withDerivedSecretName({ ...config, credentials: credentialsFrom(config) ?? [] }));
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
   * Two dishonest advertisements are dropped here: an integration whose secret
   * credentials are not in the vault (every call would 401), and an endpoint
   * needing a user-context grant the declared auth type cannot produce.
   *
   * Which credentials count against the vault is NOT decided here — it is
   * missingSecretCredentials()' policy, shared with the plugin secret gate.
   *
   * Nothing-reachable drops an integration only when it actually DECLARED
   * endpoints, because the two shapes make different claims rather than being
   * degrees of one. Declaring ZERO endpoints promises nothing that cannot be
   * delivered, and is a legitimate product shape: it is the only shape the
   * Settings "add custom integration" form can produce (it posts `endpoints:
   * []`), and what it does advertise — base URL, auth secret, extra headers —
   * is exactly what http_request needs. Declaring endpoints and reaching NONE
   * of them advertises capabilities the integration provably does not have, so
   * it is dropped whole, deliberately, even though its heading would have been
   * just as usable as the zero-endpoint one's.
   */
  private advertisable(): Array<{ integration: IntegrationConfig; endpoints: IntegrationEndpoint[] }> {
    return Array.from(this.integrations.values())
      .filter(i => i.installed && i.enabled)
      .map(integration => ({
        integration,
        endpoints: integration.endpoints.filter(ep => canAuthTypeReach(integration.authType, ep)),
      }))
      .filter(({ integration, endpoints }) =>
        (integration.endpoints.length === 0 || endpoints.length > 0) &&
        missingSecretCredentials(integration.credentials, this.secrets).length === 0);
  }

  getAgentContext(): string {
    if (isLocalOnlyMode()) return "";
    const installed = this.advertisable()
      .map(entry => ({ ...entry, transport: normalizeTransport(entry.integration.transport) }));
    if (installed.length === 0) return "";

    let ctx = "\n## Connected API Integrations\n";
    // Both lines are instructions FOR http_request — where to send the call and
    // where to put the credential — so they are emitted only when the block
    // actually contains something http_request can call. An email-only block
    // used to open by telling the model to use a tool none of its entries can
    // be reached with. Byte-identical whenever any entry is http, which is every
    // block the ten HTTP builtins appear in.
    if (installed.some(({ transport }) => transport === "http")) {
      ctx += "These APIs are configured and ready to use via the http_request tool.\n";
      ctx += "Use the secret name as {{SECRET_NAME}} in Authorization headers.\n";
    }
    ctx += "\n";

    for (const { integration: i, endpoints, transport } of installed) {
      ctx += `### ${i.icon} ${i.name} (${i.id})\n`;
      if (transport !== "http") {
        // A non-HTTP integration is NOT an http_request target: it has no base
        // URL to join a path onto, and its declared "endpoints" are pseudo-paths
        // (smtp, imap/search) no HTTP call can reach. Naming the tools that DO
        // carry it is the entire honest payload — every other line here is HTTP
        // vocabulary. `Auth:` in particular emitted {{SMTP_HOST}}…{{IMAP_USER}}
        // as Authorization-header placeholders for a transport that has no
        // headers, seven of which are not vault entries at all; the email_*
        // tools resolve their own credentials, so there was nothing for the
        // model to do with those names but misuse them.
        ctx += `Reached with the ${transportTools(transport).join(", ")} tools — not http_request.\n\n`;
        continue;
      }
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

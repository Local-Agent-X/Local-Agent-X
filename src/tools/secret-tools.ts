import type { ToolDefinition, ToolResult, ServerEvent } from "../types.js";
import type { SecretsStore } from "../secrets.js";

function ok(content: string): ToolResult {
  return { content };
}

function err(content: string): ToolResult {
  return { content, isError: true };
}

/**
 * Creates the agent tools that interact with the secrets store.
 * - request_secret: asks the user for a credential via a secure UI prompt
 * - http_request: full HTTP client that auto-resolves {{SECRET}} placeholders
 */
export function createSecretTools(
  secrets: SecretsStore,
  onEvent?: (event: ServerEvent) => void
): ToolDefinition[] {
  const requestSecretTool: ToolDefinition = {
    name: "request_secret",
    compactDescription:
      "Ask the user for an API key, token or website password through a secure prompt; stored encrypted, never in the chat. Use it instead of asking them to type a credential to you.",
    description:
      "Request an API key, token or website password from the user via a secure input prompt. The secret is stored encrypted and never appears in chat. If the secret already exists, it will confirm availability without re-prompting.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "SCREAMING_SNAKE_CASE name, e.g. GITHUB_TOKEN.",
        },
        service: {
          type: "string",
          description:
            "Display name, e.g. 'GitHub'.",
        },
        reason: {
          type: "string",
          description:
            "Why it is needed; shown in the prompt.",
        },
        url: {
          type: "string",
          description:
            "Login page, for a website password.",
        },
      },
      required: ["name", "reason"],
    },
    async execute(args) {
      const name = String(args.name || "").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      const service = args.service ? String(args.service) : undefined;
      const reason = String(args.reason || "Required for API access");
      const url = args.url ? String(args.url) : undefined;

      if (!name) {
        return err("Secret name is required.");
      }

      // If secret already exists, just confirm
      if (secrets.has(name)) {
        return ok(
          `Secret "${name}" is already stored and available. You can use it in http_request headers as {{${name}}}.`
        );
      }

      // Emit SSE event to trigger the frontend modal
      // Prefer per-request _onEvent (session-scoped) over constructor onEvent (may be stale global)
      const emit = (args._onEvent as ((event: ServerEvent) => void) | undefined) || onEvent;
      emit?.({
        type: "secret_request",
        name,
        service,
        reason,
        ...(url ? { url } : {}),
      });

      return ok(
        `Requesting "${name}" from the user via secure input. ` +
          (url
            ? `A prompt has been shown in the UI. Once they save it, fill it into ${url} with browser_fill_from_secret; it never passes through you. `
            : `A prompt has been shown in the UI. Once they provide it, you can use {{${name}}} in http_request headers. `) +
          `When they save or cancel it, that arrives as their next message; end your turn here and continue then.`
      );
    },
  };

  const requestSecretsTool: ToolDefinition = {
    name: "request_secrets",
    description:
      "Request MULTIPLE related credentials in a single secure prompt. Prefer this over calling request_secret twice " +
      "when a service uses a key/secret pair or multi-field auth. The user gets ONE modal with all fields, fills them " +
      "in together, and saves once. Common pairings to batch as a single call: " +
      "WooCommerce (WOO_CONSUMER_KEY + WOO_CONSUMER_SECRET), " +
      "Stripe (STRIPE_PUBLISHABLE_KEY + STRIPE_SECRET_KEY), " +
      "Twilio (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN), " +
      "Mailgun (MAILGUN_API_KEY + MAILGUN_DOMAIN), " +
      "OAuth apps (CLIENT_ID + CLIENT_SECRET), " +
      "AWS (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY), " +
      "SoundCloud (SOUNDCLOUD_CLIENT_ID + SOUNDCLOUD_CLIENT_SECRET). " +
      "You can also batch credentials for DIFFERENT services in one call when the user says they want to provide several at once " +
      "(e.g. 'here's my Google API and SoundCloud API') — the modal groups fields by service automatically. " +
      "Already-stored secrets are skipped automatically. If everything is already stored, no prompt is shown.",
    parameters: {
      type: "object",
      properties: {
        secrets: {
          type: "array",
          description: "List of credentials to request. Each entry needs name + reason; service is recommended for grouping.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Unique secret name in SCREAMING_SNAKE_CASE." },
              service: { type: "string", description: "Service name for display + grouping (e.g. 'WooCommerce', 'Stripe')." },
              reason: { type: "string", description: "Why this credential is needed; shown to the user." },
              url: { type: "string", description: "Website logins: the login page's address. Filled only there." },
            },
            required: ["name", "reason"],
          },
        },
      },
      required: ["secrets"],
    },
    async execute(args) {
      type SecretReq = { name: string; service?: string; reason: string; url?: string };
      const raw = Array.isArray(args.secrets) ? args.secrets : [];
      const normalized: SecretReq[] = [];
      for (const s of raw) {
        const r = s as { name?: unknown; service?: unknown; reason?: unknown; url?: unknown };
        const name = String(r.name || "").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
        if (!name) continue;
        const entry: SecretReq = { name, reason: String(r.reason || "Required for API access") };
        if (r.service) entry.service = String(r.service);
        if (r.url) entry.url = String(r.url);
        normalized.push(entry);
      }

      if (normalized.length === 0) {
        return err("request_secrets needs at least one entry with a name + reason.");
      }

      const missing = normalized.filter(s => !secrets.has(s.name));
      const existing = normalized.filter(s => secrets.has(s.name)).map(s => s.name);

      if (missing.length === 0) {
        return ok(
          `All ${normalized.length} secret(s) already stored: ${existing.join(", ")}. ` +
            `Use them as ${existing.map(n => `{{${n}}}`).join(" / ")} in http_request headers.`
        );
      }

      const emit = (args._onEvent as ((event: ServerEvent) => void) | undefined) || onEvent;
      emit?.({ type: "secrets_request", secrets: missing });

      const skippedNote = existing.length > 0
        ? ` Already stored (skipped): ${existing.join(", ")}.`
        : "";
      return ok(
        `Requesting ${missing.length} credential(s) from the user in a single secure prompt: ${missing.map(s => s.name).join(", ")}.` +
          skippedNote +
          ` Once saved, use them as ${missing.map(s => `{{${s.name}}}`).join(" / ")} in http_request headers` +
          (missing.some(s => s.url) ? `; a website login (one with a url) fills with browser_fill_from_secret on its site. ` : `. `) +
          `When they save or cancel, that arrives as their next message; end your turn here and continue then.`
      );
    },
  };

  const listSecretsTool: ToolDefinition = {
    name: "list_secrets",
    compactDescription:
      "List the NAMES of stored secrets (never the values), so you can tell whether a credential already exists before requesting one. Use it before assuming you need to ask.",
    description:
      "List the names and services of all stored secrets (API keys, tokens). " +
      "Does NOT reveal secret values — only names so you know what's available. " +
      "Use this to check if a secret exists before requesting it or using {{SECRET_NAME}} in http_request.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const list = secrets.list();
      if (list.length === 0) {
        return ok("No secrets stored. Use request_secret to ask the user for credentials.");
      }
      const lines = list.map(s => {
        const svc = s.service ? ` (${s.service})` : "";
        const acct = s.account ? ` [${s.account}]` : "";
        // A secret saved for a site is a website login: it goes into that
        // site's field through the vault, never through a request you write.
        const site = s.origin ?? s.url;
        return site
          ? `- ${s.name}${svc}${acct} — website login for ${site}: fill it with browser_fill_from_secret on that site`
          : `- ${s.name}${svc}${acct} — use as {{${s.name}}} in http_request headers`;
      });
      return ok(`Stored secrets (${list.length}):\n${lines.join("\n")}`);
    },
  };

  const getSecretMetaTool: ToolDefinition = {
    name: "get_secret_meta",
    description:
      "Read the metadata for a single stored secret — service, account, url, notes, when added — WITHOUT revealing its value. " +
      "Use this to identify what an existing saved secret is for before deciding whether to reuse it (e.g. 'is FASTMAIL the user's SMTP password?'). " +
      "Pair with list_secrets to discover names, then call this to inspect each.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact secret name (case-sensitive)." },
      },
      required: ["name"],
    },
    async execute(args) {
      const name = String(args.name || "").trim();
      if (!name) return err("name is required.");
      const meta = secrets.getMeta(name);
      if (!meta) return err(`No secret named '${name}'. Use list_secrets to see what's stored.`);
      const parts = [
        `name: ${meta.name}`,
        meta.service ? `service: ${meta.service}` : null,
        meta.account ? `account: ${meta.account}` : null,
        meta.url ? `url: ${meta.url}` : null,
        meta.notes ? `notes: ${meta.notes}` : null,
        `added: ${new Date(meta.addedAt).toISOString()}`,
        meta.updatedAt && meta.updatedAt !== meta.addedAt ? `updated: ${new Date(meta.updatedAt).toISOString()}` : null,
      ].filter(Boolean);
      return ok(parts.join("\n"));
    },
  };

  return [requestSecretTool, requestSecretsTool, listSecretsTool, getSecretMetaTool];
}

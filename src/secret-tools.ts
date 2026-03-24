import type { ToolDefinition, ToolResult, ServerEvent } from "./types.js";
import type { SecretsStore } from "./secrets.js";

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
    description:
      "Request an API key or token from the user via a secure input prompt. The secret is stored encrypted and never appears in chat. Use this when you need credentials for an API call. If the secret already exists, it will confirm availability without re-prompting.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Unique name for the secret, e.g. GITHUB_TOKEN, SLACK_BOT_TOKEN, LINEAR_API_KEY. Use SCREAMING_SNAKE_CASE.",
        },
        service: {
          type: "string",
          description:
            "Service name for display, e.g. 'GitHub', 'Slack', 'Linear'. Helps the user know what the key is for.",
        },
        reason: {
          type: "string",
          description:
            "Brief explanation of why this secret is needed, shown to the user in the prompt.",
        },
      },
      required: ["name", "reason"],
    },
    async execute(args) {
      const name = String(args.name || "").toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      const service = args.service ? String(args.service) : undefined;
      const reason = String(args.reason || "Required for API access");

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
      onEvent?.({
        type: "secret_request",
        name,
        service,
        reason,
      });

      return ok(
        `Requesting "${name}" from the user via secure input. ` +
          `A prompt has been shown in the UI. Once they provide it, you can use {{${name}}} in http_request headers. ` +
          `Wait for the user to confirm before making API calls.`
      );
    },
  };

  const listSecretsTool: ToolDefinition = {
    name: "list_secrets",
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
        return `- ${s.name}${svc} — use as {{${s.name}}} in http_request headers`;
      });
      return ok(`Stored secrets (${list.length}):\n${lines.join("\n")}`);
    },
  };

  return [requestSecretTool, listSecretsTool];
}

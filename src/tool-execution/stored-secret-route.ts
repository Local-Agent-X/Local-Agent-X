// How a call hands over a stored secret without carrying its value, keyed by
// the blocked tool. Every outbound-secret block's recovery reads it
// (egress-gates.ts, shell-block-guidance.ts), so a block points at the route
// the blocked tool actually has: a {{NAME}} placeholder is resolved only by
// http_request, and telling process_start or connector_create to use one sent
// the model to a route that does not exist for them.
import { SECRET_ENV_TOOLS } from "../tools/shell-secret-env.js";

export function storedSecretRoute(toolName: string): string {
  if (SECRET_ENV_TOOLS.has(toolName)) {
    return `Pass a stored secret to the process with secret_env: { "ENV_VAR": "SECRET_NAME" } — the value goes into its environment only, never into env, the command or your context.`;
  }
  if (toolName === "connector_create") {
    return `Reference a stored secret by its vault name in auth: {type:'bearer', secret:'NAME'} (or {type:'header', header:'X-Api-Key', secret:'NAME'}), never the raw key; store it first with request_secret.`;
  }
  return "Use {{SECRET_NAME}} placeholders in http_request instead of hardcoded credentials.";
}

/** The egress guard's recovery for a credential found in an outbound call. */
export function outboundSecretRecovery(toolName: string): string {
  const route = storedSecretRoute(toolName);
  if (SECRET_ENV_TOOLS.has(toolName) || toolName === "connector_create") {
    return `${route} Otherwise remove the secret from the call.`;
  }
  return `${route} Or remove the secret from the outbound payload. Only if the destination legitimately needs credentials, ask the user to allow its host in Settings → Security → Web access.`;
}

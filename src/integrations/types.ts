import type { CredentialRequirement } from "../credentials/requirements.js";

export type { CredentialRequirement };

export interface IntegrationEndpoint {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  description: string;
  params?: Record<string, { type: string; required?: boolean; description: string }>;
  /**
   * Which auth context the endpoint needs. DECLARED, never inferred from the
   * path. Absent means `"app"` — the endpoint is satisfied by whatever
   * credential the integration declares, which is how every endpoint behaved
   * before this field existed. `"user"` marks an endpoint that acts on a
   * signed-in person's own data and therefore needs a user-context OAuth2
   * grant: an app-level key provably cannot reach it.
   */
  authScope?: "app" | "user";
}

/**
 * What an integration DECLARES. `credentials` is the full list of values the
 * integration needs — most services need one token, some (email) need several,
 * and the single-name field this replaced could only ever express the first.
 * The requirement type is the shared one from src/credentials/requirements.ts;
 * the integrations subsystem does not define its own.
 */
export interface IntegrationDeclaration {
  id: string;
  name: string;
  icon: string;
  description: string;
  authType: "oauth2" | "api_key" | "bearer_token" | "bot_token";
  authInstructions: string;
  baseUrl: string;
  docsUrl: string;
  credentials: CredentialRequirement[];
  scopes?: string[];
  endpoints: IntegrationEndpoint[];
  headers?: Record<string, string>;
  enabled: boolean;
  installed: boolean;
  builtin: boolean;
}

/**
 * A declaration as the rest of the app sees it. `secretName` is a DERIVED view
 * of the primary credential, not a second source of truth: the install /
 * uninstall / test route and the Settings modal each handle exactly one vault
 * entry, so they keep reading one name while the schema carries the list. The
 * registry is the only writer — see primaryCredentialName() in registry.ts.
 */
export interface IntegrationConfig extends IntegrationDeclaration {
  /** Derived from `credentials[0].name`. Never hand-declared. */
  secretName: string;
}

/**
 * Whether the auth an integration declares can actually reach an endpoint.
 * Only `oauth2` carries a user-context grant, so it is the only auth type that
 * satisfies an `authScope: "user"` endpoint — the single-value types
 * (`api_key`, `bearer_token`, `bot_token`) are app credentials. An endpoint
 * that declares no scope is reachable by every auth type, so adding the field
 * to a declaration narrows nothing until that declaration opts in.
 */
export function canAuthTypeReach(
  authType: IntegrationDeclaration["authType"],
  endpoint: IntegrationEndpoint,
): boolean {
  if ((endpoint.authScope ?? "app") === "app") return true;
  return authType === "oauth2";
}

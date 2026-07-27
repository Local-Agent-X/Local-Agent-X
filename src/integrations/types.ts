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
 * How the integration's traffic is actually carried. DECLARED, never inferred
 * from an empty baseUrl. Absent means `"http"` — reachable with the
 * `http_request` tool by joining a path onto `baseUrl`, which is how every
 * integration behaved before this field existed, so adding it narrows nothing
 * until a declaration opts in. `"smtp_imap"` marks an integration `http_request`
 * provably cannot carry: it has no HTTP base URL, and its "endpoints" are
 * smtp/imap pseudo-paths that only the dedicated tools below can act on.
 */
export type IntegrationTransport = "http" | "smtp_imap";

/**
 * The tools that actually carry each non-HTTP transport. Declared rather than
 * inferred so the agent context can name a real interface instead of a "Base
 * URL:" line the integration cannot serve — an empty base URL plus a pseudo-path
 * is an invitation to call http_request and get nothing.
 */
const TRANSPORT_TOOLS: Record<Exclude<IntegrationTransport, "http">, string[]> = {
  // This list REPLACES the "Base URL:" line for a transport that has none, so
  // it is the model's only statement of what email can be reached with. Naming
  // some of the tools is worse than naming none: a model told the interface is
  // {send, read, search} will not reach for email_read_message to open the mail
  // it just listed, nor email_folders to resolve a folder name it is guessing
  // at. Appended in registration order so the three original names keep their
  // position in the rendered sentence.
  smtp_imap: ["email_send", "email_read", "email_search", "email_read_message", "email_folders"],
};

/**
 * The transport a config is stored and read under: the declared one when this
 * build knows it, `"http"` otherwise.
 *
 * Takes `unknown` deliberately. `transport` is typed, but a persisted
 * integrations.json is plain JSON nothing type-checks and POST /api/integrations
 * casts an arbitrary body into addIntegration() after validating only
 * id/name/baseUrl — so a value outside this union reaches the readers however
 * carefully the type is written. Degrading it to the shape every integration had
 * before the field existed is the same call the `endpoints` guard makes, for the
 * same reason: unindexable input reaching TRANSPORT_TOOLS threw out of
 * getAgentContext() and killed the whole request.
 *
 * TRANSPORT_TOOLS is the membership test rather than a second list of names, so
 * a transport can never be "known" and yet have no tools. hasOwn, not `in`:
 * `"toString" in TRANSPORT_TOOLS` is true and resolves to a function with no
 * `.join`.
 */
export function normalizeTransport(transport: unknown): IntegrationTransport {
  if (transport === "http") return "http";
  return typeof transport === "string" && Object.hasOwn(TRANSPORT_TOOLS, transport)
    ? (transport as IntegrationTransport)
    : "http";
}

/** The tools a non-HTTP transport is reached through; empty for `"http"`. */
export function transportTools(transport: IntegrationTransport): string[] {
  return transport === "http" ? [] : TRANSPORT_TOOLS[transport];
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
  /** Absent means `"http"`. See IntegrationTransport. */
  transport?: IntegrationTransport;
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

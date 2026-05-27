// Shared credential-deny pattern tables for MCP env construction.
//
// Two consumers — `src/mcp-client/connection.ts` (external MCP server
// spawns; default-deny stance) and `src/anthropic-client/mcp-config.ts`
// (warm-pool bridge spawn; trusted code, defense-in-depth). Keeping the
// pattern tables in one place prevents drift between the two strip
// passes; the matching function and its callers stay in connection.ts.
//
// Pure data. No logic. Uppercase-canonical forms.

export const DENY_PREFIXES: readonly string[] = [
  "ANTHROPIC_", "OPENAI_", "AWS_", "GOOGLE_", "AZURE_", "GCP_",
  "STRIPE_", "TWILIO_", "SENDGRID_", "MAILGUN_",
  "LAX_AUTH_", "SAX_AUTH_", "LAX_MCP_TOKEN",
];

export const DENY_SUBSTRINGS: readonly string[] = [
  "_KEY", "_SECRET", "_TOKEN", "_PASSWORD", "_PASSWD",
  "_CREDENTIAL", "_PRIVATE", "_API_KEY",
];

export const DENY_EXACT: readonly string[] = [
  "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "HF_TOKEN",
  "DATABASE_URL", "DB_PASSWORD",
];

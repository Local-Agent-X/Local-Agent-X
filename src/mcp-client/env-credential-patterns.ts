// Shared child-process env policy tables.
//
// Consumers — `src/mcp-client/connection.ts` (external MCP server spawns;
// default-deny stance), `src/anthropic-client/mcp-config.ts` (warm-pool
// bridge spawn; trusted code, defense-in-depth), and
// `src/self-edit/child-env.ts` (the self_edit `claude -p` subprocess;
// confidentiality scrub so a prompt-injected child can't inherit the
// user's credentials from env). Keeping the tables in one place prevents
// drift between the strip passes; the matching function and its callers
// stay in connection.ts.
//
// Pure data. No logic. Uppercase-canonical forms.

export const DENY_PREFIXES: readonly string[] = [
  "ANTHROPIC_", "OPENAI_", "AWS_", "GOOGLE_", "AZURE_", "GCP_",
  "STRIPE_", "TWILIO_", "SENDGRID_", "MAILGUN_",
  "LAX_AUTH_", "LAX_MCP_TOKEN",
];

export const DENY_SUBSTRINGS: readonly string[] = [
  "_KEY", "_SECRET", "_TOKEN", "_PASSWORD", "_PASSWD",
  "_CREDENTIAL", "_PRIVATE", "_API_KEY",
];

export const DENY_EXACT: readonly string[] = [
  "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "HF_TOKEN",
  "DATABASE_URL", "DB_PASSWORD",
];

// Vars a spawned child legitimately needs for binary resolution / shell /
// locale / temp / home — none of which carry credentials. A default-deny
// child env is built by passing ONLY these through from process.env (plus
// any explicit per-consumer grants), then running the deny tables above as
// a final strip. Used by buildMcpChildEnv (connection.ts) and
// buildSelfEditChildEnv (self-edit/child-env.ts).
export const ENV_ALLOWLIST: readonly string[] = [
  // Binary resolution
  "PATH", "PATHEXT",
  // Home dir
  "HOME", "USERPROFILE",
  // Windows shell + system paths
  "SYSTEMROOT", "WINDIR", "COMSPEC",
  // Windows user dirs
  "APPDATA", "LOCALAPPDATA",
  // Temp dirs
  "TMPDIR", "TEMP", "TMP",
  // Locale
  "LANG", "LC_ALL", "LC_CTYPE",
  // POSIX shell discovery
  "SHELL",
  // Unix identity
  "USER", "LOGNAME",
  // Linux XDG dirs
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  // Node module resolution
  "NODE_PATH",
];

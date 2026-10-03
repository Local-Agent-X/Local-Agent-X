/**
 * The /api routes the in-process agent principal may never reach.
 *
 * The agent's own http_request / web_fetch self-calls to this server carry the
 * per-process internal agent token (tools/web-egress.ts selfCallAuthHeader),
 * so any route missing from this list is reachable by an injected agent.
 * RBACManager.checkEndpoint matches each prefix as the exact path or a prefix
 * ending at "/", for every method. `place` is where in Settings the user makes
 * the change themselves: the refusal names it, so the agent can send the user
 * there instead of hunting for another route.
 */
export interface AgentDeniedRoute {
  prefix: string;
  place: string;
}

export const AGENT_DENIED_ROUTES: readonly AgentDeniedRoute[] = [
  // Deny every sensitive sink reachable over HTTP. Benign self-calls
  // (/api/settings, theme, orgs) are not under any of these prefixes.
  { prefix: "/api/secrets", place: "Settings → Secrets" },
  { prefix: "/api/tokens", place: "Settings → Security → Operator credential" },
  { prefix: "/api/plugins", place: "Settings → Tools & Integrations → Plugin Bundles" },
  { prefix: "/api/auth", place: "Settings → Account" },
  { prefix: "/api/audit", place: "Settings → Security → Audit Log" },
  { prefix: "/api/logs", place: "Settings → Security" },

  // /api/local-runtimes is EGRESS-GRANTING: a POST/DELETE there rewrites
  // settings.localRuntimes, and every entry becomes an exact host:port the
  // agent's own HTTP tools may then reach (security/layer/security-config.ts
  // manualRuntimeHostPorts → evaluateWebFetch carve-out). Without this denial
  // an injected agent could self-call POST /api/local-runtimes — self-calls
  // auto-carry the internal agent token (tools/web-egress.ts selfCallAuthHeader)
  // — to allowlist an arbitrary LAN host, then egress to it: a confused-deputy
  // privilege escalation that turns "chat may route to a named runtime" into
  // "the agent may name its own egress targets". Denied for ALL methods,
  // matching the path-only shape of the sinks above (deniedEndpoints carries no
  // method scoping); the read-only GET is denied too only because the agent
  // never needs it — its chat/routing path reads runtimes from the in-process
  // cache (local-runtimes getLocalRuntimes), not this route, which exists for
  // the operator settings UI. Keep this in sync with manualRuntimeHostPorts.
  // POST /api/settings refuses the same key from the agent
  // (routes/settings/preferences.ts OPERATOR_ONLY_SETTINGS).
  { prefix: "/api/local-runtimes", place: "Settings → AI & Models → Local Runtimes" },

  // /api/security and /api/tool-policy are SELF-GATING: they mutate the very
  // controls that bound the agent. POST /api/security/file-access sets the
  // file-access mode ("unrestricted" widens every write sink), and POST
  // /api/tool-policy/toggle flips the bash/http/browser policy rules. Neither
  // route carries its own operator check, so RBAC is the only thing standing
  // between a blocked agent and its own leash — same confused-deputy shape as
  // /api/local-runtimes above, observed in the wild 2026-07-25. User-owned
  // security controls are changed by the operator UI (which holds a real
  // operator token) or by the `setting` tool, which asks the user to approve.
  { prefix: "/api/security", place: "Settings → Security" },
  { prefix: "/api/tool-policy", place: "Settings → Security → Tool Policy" },

  // The shell cage, the approval profile and the undo log are self-gating the
  // same way, and none of their routes checks for the operator itself. POST
  // /api/sandbox turns the cage off (mode "host", or acknowledging an
  // unconfined host); POST /api/sandbox/windows-cage removes the Windows
  // fence; POST /api/autonomy/profile raises how much the agent may do without
  // asking; POST /api/rollback/undo copies backups over their originals
  // without passing the file-access gate. /api/voices/setup installs and
  // starts the voice sidecars: host processes outside the cage, run from
  // install scripts and venvs on disk that the file tools can reach. The reads
  // go with the writes because the agent needs none of them; its sandbox state
  // and autonomy profile are on /api/system-status.
  { prefix: "/api/sandbox", place: "Settings → Security → Bash Sandbox" },
  { prefix: "/api/autonomy", place: "Settings → Security → Autonomy" },
  { prefix: "/api/rollback", place: "Settings → Security → Rollback" },
  { prefix: "/api/voices/setup", place: "Settings → Media → Voice System" },

  // POST /api/mcp/servers adds a server that runs any command on this
  // computer, with no card; the agent's own path is the mcp_add_server tool,
  // which stays sandboxed and is gated as a tool call. /api/mcp/call and
  // /api/mcp/tools are the bridge the Claude CLI reaches the agent's tools
  // through, on the operator token: a self-call there would run any tool as
  // an "api" call, where no approval card is ever shown. The agent calls its
  // tools directly, so it needs none of them.
  { prefix: "/api/mcp", place: "Settings → Tools & Integrations → MCP Servers" },

  // A sync pull writes what the sync repo holds into the data dir, and the
  // agent can write into the sync repo; a configure call points sync at
  // another repository, which the next push uploads the user's memory and
  // sessions to. Only the user starts a pull or changes where sync goes.
  { prefix: "/api/sync", place: "Settings → Sync" },
];

export const AGENT_DENIED_ENDPOINTS: readonly string[] = AGENT_DENIED_ROUTES.map((r) => r.prefix);

/** Whether `pathname` is `prefix` itself or a path under it. */
export function endpointUnder(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** The denied route `pathname` falls under for the agent, or undefined. */
export function agentDeniedRouteFor(pathname: string): AgentDeniedRoute | undefined {
  return AGENT_DENIED_ROUTES.find((r) => endpointUnder(r.prefix, pathname));
}

import { deriveFilesLinkCapability } from "../server/agent-file-links.js";

// Auth token passed via setter instead of process.env to avoid leaking to
// child processes.
let _laxAuthToken = "";
let _laxPort = "";

export function setBrowserAuthContext(token: string, port: string): void {
  _laxAuthToken = token;
  _laxPort = port;
}

// Only names the browser reaches WITHOUT a DNS lookup. Other loopback aliases
// (localhost.localdomain, ip6-localhost, …) are pinned to loopback by the
// http_request dispatcher, but Chromium and the CDP egress proxy resolve them
// through the OS resolver, which can answer with a public IP that would then
// receive the operator token.
const DNS_FREE_SELF_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

const AGENT_CONTENT_PATH = /^\/(apps|dashboards|files)\//;

/** Give a navigation to this app's own server the real token. Any token
 *  already in the URL is replaced, not kept: the model only ever sees the
 *  token masked, so a URL it copies back carries the mask (or a stale token),
 *  and that page would refuse it.
 *
 *  Agent-built apps and files are the exception (server/agent-origin.ts): the
 *  server redirects them to the agent origin, which takes no operator token, so
 *  none is sent and a copied one is dropped. A /files page gets the files-link
 *  capability its redirect asks for instead. */
export function injectTokenIfLocal(url: string): string {
  try {
    const u = new URL(url);
    const appPort = _laxPort || process.env.LAX_PORT || "7007";
    if (_laxAuthToken && DNS_FREE_SELF_HOSTS.has(u.hostname) && u.port === appPort) {
      if (AGENT_CONTENT_PATH.test(u.pathname)) {
        u.searchParams.delete("token");
        if (u.pathname.startsWith("/files/")) u.searchParams.set("ft", deriveFilesLinkCapability(_laxAuthToken));
      } else {
        u.searchParams.set("token", _laxAuthToken);
      }
      return u.toString();
    }
  } catch { /* invalid URL — caller handles */ }
  return url;
}

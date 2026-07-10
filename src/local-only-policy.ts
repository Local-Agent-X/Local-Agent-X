import { getRuntimeConfig } from "./config.js";
import type { LAXConfig } from "./types.js";

export const LOCAL_ONLY_BLOCK_MESSAGE =
  "Blocked by strict local-only mode: only loopback network access and local models are allowed.";

export interface LocalOnlyDecision {
  allowed: boolean;
  reason?: string;
}

export function isLocalOnlyMode(config: Pick<LAXConfig, "localOnlyMode"> = getRuntimeConfig()): boolean {
  return config.localOnlyMode === true;
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
    const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase().replace(/\.$/, "");
    if (host === "localhost" || host === "::1") return true;
    const match = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    return !!match && match.slice(1).every((part) => Number(part) <= 255);
  } catch {
    return false;
  }
}

export function localProviderDecision(
  provider: string,
  config: Pick<LAXConfig, "localOnlyMode" | "ollamaUrl"> = getRuntimeConfig(),
  customBaseUrl?: string,
): LocalOnlyDecision {
  if (!isLocalOnlyMode(config)) return { allowed: true };
  if (provider === "local" && isLoopbackUrl(config.ollamaUrl)) return { allowed: true };
  if (provider === "custom" && customBaseUrl && isLoopbackUrl(customBaseUrl)) return { allowed: true };
  return { allowed: false, reason: LOCAL_ONLY_BLOCK_MESSAGE };
}

const REMOTE_ONLY_TOOLS = new Set([
  "bash", "shell", "ari_shell", "process_start", "process_restart",
  "app_serve_backend", "app_serve_frontend",
  "web_search", "image_search", "extract_site_assets", "youtube_analyze",
  "generate_image", "edit_image", "generate_video", "email_send",
  "telegram_send", "whatsapp_send", "send_image", "send_video",
  "check_for_updates", "apply_update", "connector_create",
]);

export function localOnlyToolDecision(
  name: string,
  args: Record<string, unknown>,
  config: Pick<LAXConfig, "localOnlyMode"> = getRuntimeConfig(),
): LocalOnlyDecision {
  if (!isLocalOnlyMode(config)) return { allowed: true };
  if (name.startsWith("mcp_")) return { allowed: false, reason: LOCAL_ONLY_BLOCK_MESSAGE };
  if (REMOTE_ONLY_TOOLS.has(name)) return { allowed: false, reason: LOCAL_ONLY_BLOCK_MESSAGE };
  if (name === "http_request" || name === "web_fetch" || name === "ari_http") {
    return typeof args.url === "string" && isLoopbackUrl(args.url)
      ? { allowed: true }
      : { allowed: false, reason: LOCAL_ONLY_BLOCK_MESSAGE };
  }
  if (name === "browser" || name.startsWith("browser_")) {
    const target = args.url ?? args.href;
    if (typeof target !== "string" || target === "" || isLoopbackUrl(target)) return { allowed: true };
    return { allowed: false, reason: LOCAL_ONLY_BLOCK_MESSAGE };
  }
  return { allowed: true };
}

export function localOnlyRouteDecision(
  method: string,
  pathname: string,
  config: Pick<LAXConfig, "localOnlyMode"> = getRuntimeConfig(),
): LocalOnlyDecision {
  if (!isLocalOnlyMode(config)) return { allowed: true };
  if (pathname.startsWith("/api/auth/") || pathname.startsWith("/api/account/")) {
    return { allowed: false, reason: LOCAL_ONLY_BLOCK_MESSAGE };
  }
  if (pathname.startsWith("/api/updates/")) return { allowed: false, reason: LOCAL_ONLY_BLOCK_MESSAGE };
  if (pathname === "/api/ollama/test-cloud") return { allowed: false, reason: LOCAL_ONLY_BLOCK_MESSAGE };
  if (method !== "GET" && (
    pathname.startsWith("/api/integrations") || pathname.startsWith("/api/mcp/servers") ||
    pathname.startsWith("/api/sync/") || pathname.startsWith("/api/telegram/") ||
    pathname.startsWith("/api/whatsapp/")
  )) return { allowed: false, reason: LOCAL_ONLY_BLOCK_MESSAGE };
  return { allowed: true };
}

type Teardown = () => void | Promise<void>;
const remoteTeardowns = new Map<string, Teardown>();

export function registerLocalOnlyTeardown(name: string, teardown: Teardown): () => void {
  remoteTeardowns.set(name, teardown);
  return () => remoteTeardowns.delete(name);
}

export async function activateLocalOnlyMode(): Promise<void> {
  await Promise.allSettled([...remoteTeardowns.values()].map((teardown) => teardown()));
  const [{ closeAllBrowsers }, { closeBrowserEgressProxy }, { MCPManager }, account] = await Promise.all([
    import("./browser/index.js"),
    import("./browser/egress-proxy.js"),
    import("./mcp-client/index.js"),
    import("./broker-transport/account/runtime.js"),
  ]);
  account.stopBrokerPresence();
  MCPManager.getInstance().suspendForLocalOnly();
  await Promise.allSettled([closeAllBrowsers(), closeBrowserEgressProxy()]);
}

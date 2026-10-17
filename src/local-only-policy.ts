import { getRuntimeConfig } from "./config.js";
import type { LAXConfig } from "./types.js";
import { isPrivateIPv4, isPrivateIPv6 } from "./security/layer/ip-classification.js";
import { destinationSpecsOf, hasCapability, policyRowOf, type ToolRisk } from "./tool-registry.js";

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

/**
 * Loopback OR private-range (RFC1918/ULA/link-local…) endpoint URL — "is this
 * a machine the user runs themselves" for guard-rail TARGETING (local-model
 * token caps, degenerate-stream guards). NOT a security gate: unknown or
 * unparseable hosts classify as NOT local (fail toward "cloud, leave the
 * request untouched"), the opposite failure direction from the SSRF layer's
 * fail-closed classifiers this reuses. DNS names other than localhost — even
 * LAN ones like `myserver.lan` — classify as not local: never cap a hostname
 * we can't prove is private.
 */
export function isLoopbackOrPrivateUrl(value: string): boolean {
  if (isLoopbackUrl(value)) return true;
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    return false;
  }
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return isPrivateIPv4(bare);
  if (bare.includes(":")) return isPrivateIPv6(bare);
  return false;
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

/** Tools that reach the network through something their row cannot name:
 *  a builder's package installs, an update download, a manifest the proxy
 *  serves later, a subprocess outside the egress guard. */
const INDIRECT_NETWORK: Readonly<Record<string, string>> = {
  build_app: "its builder installs packages and fetches assets",
  start_app_build: "its builder installs packages and fetches assets",
  finalize_app_build: "its builder installs packages and fetches assets",
  run_build_plan: "its builder installs packages and fetches assets",
  apply_update: "downloads the update",
  connector_create: "routes an app's traffic to the upstream it names",
  youtube_analyze: "yt-dlp fetches outside the egress guard, so a loopback URL proves nothing",
};

/** Subprocess tools whose reach is a device in the user's hands, not the
 *  network: adb drives a plugged-in phone or an emulator on this box. */
const LOCAL_DEVICE: Readonly<Record<string, string>> = {
  android: "adb reaches a plugged-in device or an emulator on this box",
};

const NETWORK_RISKS: ReadonlySet<ToolRisk> = new Set(["network-read", "network-write", "external-comms"]);

/** Does this call leave the box, as its row describes the tool? A tool
 *  addressed by URL is judged by where this call points (a loopback dev server
 *  is local); any other tool leaves when the kernel classes it as HTTP, it runs
 *  a shell, its risk is a network tier, or it delivers to a service or a
 *  person. A plugin tool hands its arguments to a program that may send them
 *  anywhere. Egress to the configured model (view_image, transcribe_media) is
 *  not judged here: the provider decision keeps that model local. */
export function localOnlyToolDecision(
  name: string,
  args: Record<string, unknown>,
  config: Pick<LAXConfig, "localOnlyMode"> = getRuntimeConfig(),
): LocalOnlyDecision {
  if (!isLocalOnlyMode(config)) return { allowed: true };
  const blocked = { allowed: false, reason: LOCAL_ONLY_BLOCK_MESSAGE };
  if (name.startsWith("mcp_") || name in INDIRECT_NETWORK) return blocked;
  const row = policyRowOf(name);
  if (!row) return { allowed: true };
  const specs = destinationSpecsOf(name, args) ?? [];
  const site = specs.find((s) => s.to === "site");
  if (site) return typeof args[site.arg] === "string" && isLoopbackUrl(args[site.arg] as string) ? { allowed: true } : blocked;
  const page = specs.find((s) => s.to === "browser-page");
  if (page) {
    const target = page.arg ? args[page.arg] : undefined;
    return typeof target !== "string" || target === "" || isLoopbackUrl(target) ? { allowed: true } : blocked;
  }
  if (name in LOCAL_DEVICE) return { allowed: true };
  if (row.kernel === "http" || hasCapability(name, "shell") || NETWORK_RISKS.has(row.risk)) return blocked;
  if (specs.some((s) => s.to === "service" || s.to === "recipients" || s.to === "chat" || (s.to === "user" && s.message))) return blocked;
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
  const [{ closeAllBrowsers }, { closeBrowserEgressProxy }, { closeAllVoiceSessions }, { MCPManager }, account] = await Promise.all([
    import("./browser/index.js"),
    import("./browser/egress-proxy.js"),
    import("./voice/audio-ws.js"),
    import("./mcp-client/index.js"),
    import("./broker-transport/account/runtime.js"),
  ]);
  account.stopBrokerPresence();
  closeAllVoiceSessions();
  MCPManager.getInstance().suspendForLocalOnly();
  await Promise.allSettled([closeAllBrowsers(), closeBrowserEgressProxy()]);
}

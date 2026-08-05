import {
  parseConnectTarget,
  startEgressProxy,
  type EgressProxy,
  type EgressProxyOptions,
  type ProxyDialTarget,
} from "../net/egress-proxy-core.js";
import { getRuntimeConfig } from "../config.js";

export type BrowserProxyDialTarget = ProxyDialTarget;

export type BrowserEgressProxyOptions = Omit<EgressProxyOptions, "selfPort" | "viaTag">;

export type BrowserEgressProxy = EgressProxy;

export { parseConnectTarget };

function selfPort(): string {
  return process.env.LAX_PORT ?? String(getRuntimeConfig().port);
}

export function startBrowserEgressProxy(
  options: BrowserEgressProxyOptions = {},
): Promise<BrowserEgressProxy> {
  return startEgressProxy({
    ...options,
    selfPort,
    viaTag: "1.1 lax-browser-egress",
  });
}

let sharedProxy: Promise<BrowserEgressProxy> | null = null;

export function ensureBrowserEgressProxy(): Promise<BrowserEgressProxy> {
  if (!sharedProxy) {
    sharedProxy = startBrowserEgressProxy().catch((error) => {
      sharedProxy = null;
      throw error;
    });
  }
  return sharedProxy;
}

export async function closeBrowserEgressProxy(): Promise<void> {
  const active = sharedProxy;
  sharedProxy = null;
  if (active) await (await active).close();
}

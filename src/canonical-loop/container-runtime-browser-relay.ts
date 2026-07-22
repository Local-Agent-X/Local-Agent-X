import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTAINER_BROWSER_RELAY_FLAG,
  CONTAINER_BROWSER_RELAY_SOCKET,
  CONTAINER_BROWSER_RELAY_TOKEN,
  startBrowserContainerRelay,
  type BrowserRelayServerHandle,
} from "../browser/container-bridge-relay.js";
import {
  browserAbortDesktop,
  requestDesktopBrowserBridge,
} from "../browser/bridge-client.js";

export const BROWSER_RELAY_TOKEN_FILE = "secrets/browser-relay-token";
const CONTAINER_RELAY_SOCKET = "/var/lib/lax/browser-relay.sock";

export interface ProjectionBrowserRelay {
  environment: Record<string, string>;
  close(): Promise<void>;
}

export function createProjectionBrowserRelayToken(root: string): string {
  const path = join(root, BROWSER_RELAY_TOKEN_FILE);
  writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  return path;
}

export async function openProjectionBrowserRelay(
  root: string,
  identity: { device: string; inode: string },
  ownerSessionId: string,
): Promise<ProjectionBrowserRelay> {
  if (!ownerSessionId) {
    throw new Error("container browser relay requires an owning session");
  }
  const tokenPath = join(root, BROWSER_RELAY_TOKEN_FILE);
  const stat = lstatSync(tokenPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64) {
    throw new Error("container browser relay token is invalid");
  }
  const exact = lstatSync(tokenPath, { bigint: true });
  if (exact.dev.toString() !== identity.device || exact.ino.toString() !== identity.inode) {
    throw new Error("container browser relay token identity changed");
  }
  const token = readFileSync(tokenPath, "utf8");
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("container browser relay token is invalid");
  }
  const handle: BrowserRelayServerHandle = await startBrowserContainerRelay({
    socketPath: join(root, "state", "browser-relay.sock"),
    token,
    ownerSessionId,
    handler: { request: requestDesktopBrowserBridge, abort: browserAbortDesktop },
  });
  return {
    environment: {
      [CONTAINER_BROWSER_RELAY_FLAG]: "1",
      [CONTAINER_BROWSER_RELAY_SOCKET]: CONTAINER_RELAY_SOCKET,
      [CONTAINER_BROWSER_RELAY_TOKEN]: token,
    },
    close: () => handle.close(),
  };
}

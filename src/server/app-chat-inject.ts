// The page's half of app chat: window.lax.chat (public/js/app-chat-client.js),
// installed in every workspace app page with that app's id and its chat
// capability (app-connector-auth.ts), so an app talks to the user's agents
// through one helper instead of each hand-rolling the stream. The capability
// opens nothing until the user allows the app (routes/app-chat.ts).
//
// Both the static /apps route and the dev-server proxy inject it, on the
// desktop only: a phone over the broker reaches /api through the UI origin,
// where these calls are not served. Export strips the block by its
// `data-lax-app-chat` mark (public/js/apps.js).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveAppChatCapability } from "./app-connector-auth.js";

let cached: { publicDir: string; source: string } | null = null;

function clientSource(publicDir: string): string {
  if (cached?.publicDir !== publicDir) {
    cached = { publicDir, source: readFileSync(join(publicDir, "js", "app-chat-client.js"), "utf-8") };
  }
  return cached.source;
}

/** Script block installing window.lax.chat for one app. Empty for a segment
 *  that is not an app id, so nothing unescaped is ever written into the page. */
export function appChatClientScript(publicDir: string, operatorToken: string, appId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(appId)) return "";
  const capability = deriveAppChatCapability(operatorToken, appId);
  return `<script data-lax-app-chat>${clientSource(publicDir)}\n;__laxInstallAppChat(${JSON.stringify(appId)},${JSON.stringify(capability)});</script>`;
}

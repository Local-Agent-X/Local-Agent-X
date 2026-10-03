// The app page's half of the IDE element picker and runtime-error capture.
//
// The IDE previews an app in an iframe of the UI. The app is served from the
// agent origin (agent-origin.ts), so the UI cannot reach into that document to
// install either tool, as it did when both shared one origin. The server
// installs them in the page instead: the shared capture core
// (public/js/apps-error-pipe-core.js, the same one the phone pipe injects) and
// the frame bridge (public/js/apps-ide-frame-bridge.js), which posts errors and
// picks only to the UI's origins and takes picker orders only from its parent at
// one of them. The UI half is public/js/apps-ide-picker.js and apps-ide-errors.js.
// Both the static /apps route and the dev-server proxy inject it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: { publicDir: string; source: string } | null = null;

function bridgeSource(publicDir: string): string {
  if (cached?.publicDir !== publicDir) {
    const read = (file: string) => readFileSync(join(publicDir, "js", file), "utf-8");
    cached = { publicDir, source: read("apps-error-pipe-core.js") + "\n" + read("apps-ide-frame-bridge.js") };
  }
  return cached.source;
}

/** The origins the UI is served from: the desktop loads 127.0.0.1, and a
 *  browser user may type localhost. Both name the UI's own listener. */
export function uiOrigins(uiPort: number): string[] {
  return [`http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`];
}

/** Script block installing the frame bridge, addressed to this UI's origins. */
export function ideFrameBridgeScript(publicDir: string, uiPort: number): string {
  return `<script>${bridgeSource(publicDir)}\n;__laxInstallIdeFrameBridge(${JSON.stringify(uiOrigins(uiPort))});</script>`;
}

/**
 * Page orchestrator — assembles the full HTML document: head + nonce'd style +
 * header + components + status indicator + nonce'd client script.
 */

import type { AppDefinition } from "../app-runtime/index.js";
import { randomBytes } from "node:crypto";
import { renderLayout } from "./layout.js";
import { escapeHtml } from "./sanitize.js";
import { APP_STYLES } from "./styles.js";
import { renderClientScript } from "./client-script.js";

export function renderApp(def: AppDefinition, port?: number): string {
  const apiBase = `http://127.0.0.1:${port || 7007}`;
  const nonce = randomBytes(16).toString("base64");
  const componentsHtml = renderLayout(def.layout, def.components);
  const statusBadge = def.status !== "active"
    ? `<span class="app-status-badge app-status-${escapeHtml(def.status)}">${escapeHtml(def.status.toUpperCase())}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-Content-Type-Options" content="nosniff">
  <title>${escapeHtml(def.name)} — App</title>
  <style nonce="${nonce}">${APP_STYLES}</style>
</head>
<body>
  <div class="app-header">
    <div>
      <h1>${escapeHtml(def.name)} ${statusBadge}</h1>
      <div class="app-desc">${escapeHtml(def.description)}</div>
    </div>
    <span class="app-version">v${def.version}</span>
  </div>
  ${componentsHtml}
  <div class="app-status" id="app-status"><span class="app-status-dot"></span> Connecting...</div>

<script nonce="${nonce}">${renderClientScript(def.id, apiBase)}</script>
</body>
</html>`;
}

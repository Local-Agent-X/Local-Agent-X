import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("tools.builder-tools");

export const buildAppTool: ToolDefinition = {
  name: "build_app",
  description: "Build a complete web app in workspace/apps/ using a dedicated CLI subprocess. Use this for NEW apps and LARGE rewrites. For small edits to existing apps, use read + edit directly instead. Returns the app URL when done.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "App directory name (e.g. 'trading-bot', 'todo-app')" },
      prompt: { type: "string", description: "Detailed description of what to build. Be specific about features, styling, behavior." },
      backend: { type: "string", enum: ["codex", "claude", "auto"], description: "Which CLI to use. 'auto' (default) matches your active provider. 'codex' = codex CLI. 'claude' = claude CLI." },
    },
    required: ["name", "prompt"],
  },
  async execute(args) {
    const appName = String(args.name || "app").replace(/[^a-zA-Z0-9_-]/g, "-");
    const prompt = String(args.prompt || "");
    let backend = String(args.backend || "auto");

    if (backend === "auto") {
      try {
        const settingsPath = join(process.env.HOME || process.env.USERPROFILE || "", ".lax", "settings.json");
        if (existsSync(settingsPath)) {
          const s = JSON.parse(readFileSync(settingsPath, "utf-8"));
          if (s.provider === "codex") backend = "codex";
          else if (s.provider === "anthropic") backend = "claude";
          else {
            return {
              content: `For provider "${s.provider}", use the write tool directly instead of build_app. Create files at workspace/apps/${appName}/index.html — the HTTP API doesn't truncate large tool calls like ChatGPT subscription does.`,
              isError: true,
            };
          }
        } else { backend = "claude"; }
      } catch { backend = "claude"; }
    }

    const appDir = resolve("workspace", "apps", appName);
    const port = process.env.LAX_PORT ?? process.env.SAX_PORT ?? "7007";
    const appUrl = `http://127.0.0.1:${port}/apps/${appName}/index.html`;

    mkdirSync(appDir, { recursive: true });

    const isUpdate = existsSync(resolve(appDir, "index.html"));
    const contextFiles: string[] = [];
    if (isUpdate) {
      for (const f of ["PROJECT.md", "TODO.md", "index.html"]) {
        const p = resolve(appDir, f);
        if (existsSync(p)) {
          try { contextFiles.push(`=== ${f} ===\n${readFileSync(p, "utf-8").slice(0, 3000)}`); } catch {}
        }
      }
    }
    const context = contextFiles.length > 0 ? `\n\nExisting app context:\n${contextFiles.join("\n\n")}` : "";

    const builderPrompt = `You are building a web app in the directory: ${appDir}
App name: ${appName}
Task: ${isUpdate ? "UPDATE existing app" : "CREATE new app"}
${context}

Instructions: ${prompt}

RULES:
- Write ALL files to ${appDir}/ (use absolute paths)
- The main entry point MUST be index.html
- Create PROJECT.md with app description and status
- For single-page apps: put everything in index.html (inline CSS/JS is fine)
- Make it look polished — use modern CSS, good colors, responsive design
- The app will be served at ${appUrl}
- If using images from the web, use full URLs (https://)
- Do NOT ask questions — just build it based on the instructions
- After writing files, output: APP_READY: ${appUrl}`;

    try {
      if (backend === "codex") {
        const result = await buildWithCodex(builderPrompt, appDir, appUrl);
        if (result.isError && !existsSync(resolve(appDir, "index.html"))) {
          logger.warn(`[build_app] Codex failed, falling back to Claude CLI`);
          return await buildWithClaude(builderPrompt, appDir, appUrl);
        }
        return result;
      }
      return await buildWithClaude(builderPrompt, appDir, appUrl);
    } catch (e) {
      return { content: `Build failed: ${(e as Error).message}`, isError: true };
    }
  },
};

export async function buildWithCodex(prompt: string, appDir: string, appUrl: string): Promise<ToolResult> {
  try {
    const { spawn: spawnChild } = await import("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawnChild("codex", [
        "--full-auto",
        "--no-color",
      ], {
        cwd: appDir,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      proc.stdin?.write(prompt);
      proc.stdin?.end();
      let out = "", errOut = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { errOut += d.toString(); });
      const timer = setTimeout(() => { proc.kill(); reject(new Error("Codex CLI build timed out after 5 minutes")); }, 300_000);
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(errOut || out || `Codex CLI exit code ${code}`));
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Codex CLI not available: ${err.message}. Install with: npm install -g @openai/codex`));
      });
    });

    const output = stdout.trim();
    if (output.includes("APP_READY") || existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built with Codex CLI!\n\nOpen: ${appUrl}\n\n${output.slice(-500)}` };
    }
    return { content: `Codex CLI finished but index.html not found.\n${output.slice(-1000)}`, isError: true };
  } catch (e) {
    const errMsg = (e as Error).message || "unknown";
    if (existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built (with warnings)!\n\nOpen: ${appUrl}\n\n${errMsg.slice(0, 300)}` };
    }
    return { content: `Codex CLI build failed: ${errMsg.slice(0, 500)}`, isError: true };
  }
}

export async function buildWithClaude(prompt: string, appDir: string, appUrl: string): Promise<ToolResult> {
  try {
    const { spawn: spawnChild } = await import("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawnChild("claude", [
        "-p",
        "--output-format", "text",
        "--no-session-persistence",
        "--max-turns", "25",
        "--model", "claude-opus-4-7",
        "--tools", "Write,Edit,Read,Bash",
        "--disallowedTools", "WebFetch,WebSearch",
      ], {
        cwd: appDir,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      proc.stdin?.write(prompt);
      proc.stdin?.end();
      let out = "", errOut = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { errOut += d.toString(); });
      const timer = setTimeout(() => { proc.kill(); reject(new Error("Claude CLI build timed out after 5 minutes")); }, 300_000);
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(errOut || `Claude CLI exit code ${code}`));
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Claude CLI not available: ${err.message}. Install with: npm install -g @anthropic-ai/claude-code`));
      });
    });

    const output = stdout.trim();
    if (output.includes("APP_READY") || existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built with Claude CLI!\n\nOpen: ${appUrl}\n\n${output.slice(-500)}` };
    }
    return { content: `Claude CLI finished but index.html not found.\n${output.slice(-1000)}`, isError: true };
  } catch (e) {
    const errMsg = (e as Error).message || "unknown";
    if (existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built (with warnings)!\n\nOpen: ${appUrl}\n\n${errMsg.slice(0, 300)}` };
    }
    return { content: `Claude CLI build failed: ${errMsg.slice(0, 500)}`, isError: true };
  }
}

export const createPageTool: ToolDefinition = {
  name: "create_page",
  description:
    "Create a custom page inside the app. The page is served at /<name>.html and appears in the sidebar. " +
    "Use this to build dashboards, tools, visualizations, or any custom UI directly inside the app. " +
    "The page automatically gets the app's dark theme CSS variables.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Page slug (e.g. 'my-dashboard'). Served at /<name>.html" },
      title: { type: "string", description: "Human-readable page title for the sidebar" },
      content: { type: "string", description: "Full HTML content. Can include inline <style> and <script> tags. The app's CSS variables (--bg, --fg, --accent, etc.) are available." },
    },
    required: ["name", "title", "content"],
  },
  async execute(args) {
    const name = String(args.name || "page").replace(/[^a-zA-Z0-9_-]/g, "-");
    const title = String(args.title || name);
    const content = String(args.content || "");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Open Agent X</title>
  <link rel="stylesheet" href="/css/theme.css">
  <style>
    body { background: var(--bg, #0a0a0a); color: var(--fg, #e0e0e0); font-family: var(--sans, system-ui, sans-serif); margin: 0; padding: 20px; }
    a { color: var(--accent, #00d4ff); }
  </style>
</head>
<body>
${content}
<script>
  // Expose API helper for custom pages
  const API = window.location.origin;
  const AUTH_TOKEN = localStorage.getItem('sax_token') || '';
  async function apiGet(path) {
    const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + AUTH_TOKEN } });
    return r.json();
  }
  async function apiPost(path, data) {
    const r = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AUTH_TOKEN },
      body: JSON.stringify(data)
    });
    return r.json();
  }
</script>
</body>
</html>`;

    try {
      const publicDir = resolve(import.meta.dirname || ".", "..", "..", "public");
      mkdirSync(publicDir, { recursive: true });
      writeFileSync(join(publicDir, `${name}.html`), html, "utf-8");

      const registryPath = join(process.env.HOME || process.env.USERPROFILE || "", ".lax", "custom-pages.json");
      let registry: Array<{ name: string; title: string; createdAt: number }> = [];
      try {
        if (existsSync(registryPath)) registry = JSON.parse(readFileSync(registryPath, "utf-8"));
      } catch {}
      const idx = registry.findIndex(p => p.name === name);
      if (idx >= 0) registry[idx] = { name, title, createdAt: registry[idx].createdAt };
      else registry.push({ name, title, createdAt: Date.now() });
      writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");

      const port = process.env.LAX_PORT ?? process.env.SAX_PORT ?? "7007";
      return { content: `Page created: http://127.0.0.1:${port}/${name}.html\nTitle: ${title}\nRegistered in sidebar.` };
    } catch (e) {
      return { content: `Failed to create page: ${(e as Error).message}`, isError: true };
    }
  },
};

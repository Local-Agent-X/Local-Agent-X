import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { renderBuilderPrompt, listAssetsDir, readUpdateContextFiles } from "./render-builder-prompt.js";

export const buildAppTool: ToolDefinition = {
  name: "build_app",
  description: "Build a complete web app in workspace/apps/ using a dedicated CLI subprocess. Use this for NEW apps and LARGE rewrites. For small edits to existing apps, use read + edit directly instead. Returns the app URL when done. When reporting success to the user, include the full URL verbatim on its own line (e.g. `http://127.0.0.1:7007/apps/<name>/index.html`) so it renders as a clickable link — do NOT paraphrase to a relative path like `/apps/<name>/`.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "App directory name (e.g. 'trading-bot', 'todo-app')" },
      prompt: { type: "string", description: "Build brief — what to make, target features, styling notes, behavior. Be specific." },
      backend: { type: "string", enum: ["codex", "claude", "auto"], description: "Which CLI to use. 'auto' (default) matches your active provider. 'codex' = codex CLI. 'claude' = claude CLI." },
    },
    required: ["name", "prompt"],
  },
  async execute(args) {
    if (process.env.LAX_BUILD_APP_CANONICAL === "1" || process.env.LAX_BUILD_APP_CANONICAL === "true") {
      const { buildAppCanonicalTool } = await import("./build-app-canonical.js");
      return buildAppCanonicalTool.execute(args);
    }
    const appName = String(args.name || "app").replace(/[^a-zA-Z0-9_-]/g, "-");
    // Some models occasionally emit `description` instead of `prompt` because
    // the schema's parameter description used to contain the word
    // "description"; fixed in the schema above, but still accept the alias
    // for back-compat with model-version variance. Live failure 2026-05-14
    // on Anthropic Opus 4.7 — prompt missing, description present.
    const prompt = String(args.prompt || args.description || "");
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
    const contextFiles = isUpdate ? readUpdateContextFiles(appDir) : [];
    const assetFiles = listAssetsDir(appDir);

    const builderPrompt = renderBuilderPrompt({
      appName,
      prompt,
      appDir,
      appUrl,
      isUpdate,
      contextFiles,
      assetFiles,
    });

    try {
      // No silent provider fallback. If Codex was selected (because the user
      // is on the Codex provider) and the Codex CLI fails — most commonly
      // because the ChatGPT subscription endpoint truncates large tool
      // outputs and the build doesn't finish writing index.html — surface
      // the error so the user/model can act on it. Earlier this transparently
      // fell back to the Claude CLI, which:
      //   1. hid which provider actually did the work,
      //   2. masked the truncation problem so we never fixed it upstream,
      //   3. produced silent UI gaps because the user thought their selected
      //      provider was working when it wasn't.
      // The model gets a clear error and can decide to retry, simplify the
      // build, or ask the user to switch providers.
      // Per-call onEvent (when present) lets the tool stream progress
      // updates to the chat UI. Without it, the user stares at "executing..."
      // for 1-5 minutes while the CLI subprocess runs silently. With it, the
      // codex/claude CLI's own status lines surface as live progress chips
      // ("Reading project structure...", "Writing index.html...", etc.).
      const onEvent = (args._onEvent && typeof args._onEvent === "function")
        ? args._onEvent as (e: { type: string; [k: string]: unknown }) => void
        : undefined;
      if (backend === "codex") {
        return await buildWithCodex(builderPrompt, appDir, appUrl, onEvent);
      }
      return await buildWithClaude(builderPrompt, appDir, appUrl, onEvent);
    } catch (e) {
      return { content: `Build failed: ${(e as Error).message}`, isError: true };
    }
  },
};

/** Pipe a child process's stdout/stderr into `tool_progress` events on
 *  `onEvent`, throttled so we don't spam the chat UI. The progress message
 *  is the most recent non-empty line, emitted at most once per `minIntervalMs`.
 *  Pass `parseLine` to transform each raw line into a human-readable string
 *  (return null to skip the line entirely) — used by the Claude CLI path
 *  whose stream-json output is JSONL, not free-form text.
 *  Returns a cleanup function that flushes any pending message. */
function streamProgress(
  proc: { stdout?: NodeJS.ReadableStream | null; stderr?: NodeJS.ReadableStream | null },
  toolName: string,
  onEvent: ((e: { type: string; [k: string]: unknown }) => void) | undefined,
  minIntervalMs = 750,
  parseLine?: (line: string) => string | null,
): () => void {
  if (!onEvent) return () => { /* no-op */ };
  let lastLine = "";
  let lastEmit = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const tryEmit = (force: boolean): void => {
    if (!lastLine) return;
    const now = Date.now();
    const gap = now - lastEmit;
    if (force || gap >= minIntervalMs) {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      lastEmit = now;
      try { onEvent({ type: "tool_progress", toolName, message: lastLine.slice(0, 160) }); } catch { /* swallow */ }
    } else if (!pendingTimer) {
      pendingTimer = setTimeout(() => { pendingTimer = null; tryEmit(true); }, minIntervalMs - gap);
    }
  };
  const onChunk = (d: Buffer): void => {
    const text = d.toString();
    for (const raw of text.split(/\r?\n/)) {
      const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
      if (stripped.length === 0) continue;
      const transformed = parseLine ? parseLine(stripped) : stripped;
      if (transformed === null) continue;
      if (transformed.length < 3) continue; // skip single-char decoration
      lastLine = transformed;
    }
    tryEmit(false);
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);
  return () => {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    tryEmit(true);
  };
}

/** Parse a single line of `claude --output-format stream-json --verbose`
 *  into a human-readable progress string. Returns null to skip the line. */
function parseClaudeStreamLine(line: string, finalTextRef: { value: string }): string | null {
  let evt: { type?: string; subtype?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string }> }; result?: string };
  try { evt = JSON.parse(line); } catch { return line.slice(0, 200); }
  if (evt.type === "system" && evt.subtype === "init") return "Claude CLI starting…";
  if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const t = block.text.trim();
        finalTextRef.value = t;
        return t.slice(0, 200);
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        return `Calling ${block.name}…`;
      }
    }
  }
  if (evt.type === "result" && typeof evt.result === "string") {
    finalTextRef.value = evt.result;
    return null; // build is done — the close handler emits the final summary
  }
  return null;
}

export async function buildWithCodex(
  prompt: string,
  appDir: string,
  appUrl: string,
  onEvent?: (e: { type: string; [k: string]: unknown }) => void,
): Promise<ToolResult> {
  try {
    const { spawn: spawnChild } = await import("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      // Modern @openai/codex CLI rewrote its argument surface — it now
      // requires the `exec` subcommand for non-interactive use, rejects
      // the old `--full-auto` flag, and uses `--color <mode>` instead of
      // `--no-color`. Live failure 2026-05-14 after the user installed a
      // recent codex CLI: "error: unexpected argument '--full-auto'".
      // Equivalents on the new CLI:
      //   --full-auto                    → --dangerously-bypass-approvals-and-sandbox
      //   --no-color                     → --color never
      //   (run outside a git repo)        → --skip-git-repo-check
      // The "dangerously" flag is acceptable here: build_app runs the
      // agent inside workspace/apps/<name>/, which is already scoped to
      // the user's own machine and explicitly invoked by them. The flag
      // disables codex's internal confirmation prompts, not LAX's own
      // safety layer (ari-kernel etc).
      const proc = spawnChild("codex", [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--color", "never",
      ], {
        cwd: appDir,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
        env: { ...process.env, NO_COLOR: "1" },
      });
      proc.stdin?.write(prompt);
      proc.stdin?.end();
      let out = "", errOut = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { errOut += d.toString(); });
      const stopProgress = streamProgress(proc, "build_app", onEvent);
      const timer = setTimeout(() => { proc.kill(); reject(new Error("Codex CLI build timed out after 5 minutes")); }, 300_000);
      proc.on("close", (code) => {
        clearTimeout(timer);
        stopProgress();
        if (code === 0) resolve(out);
        else reject(new Error(errOut || out || `Codex CLI exit code ${code}`));
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        stopProgress();
        reject(new Error(`Codex CLI not available: ${err.message}. Install with: npm install -g @openai/codex`));
      });
    });

    const output = stdout.trim();
    if (output.includes("APP_READY") || existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built with Codex CLI!\n\nOpen: ${appUrl}\n\n${output.slice(-500)}` };
    }
    // Common cause: the ChatGPT subscription endpoint truncates large tool
    // outputs mid-stream, so the model emits the start of index.html but
    // never finishes the file write. The build appears to "succeed" (exit
    // code 0, output looks plausible) but no file lands on disk. Tell the
    // user/model exactly what happened so they can react — switch to a
    // smaller scope, retry, or ask the user to switch providers.
    return {
      content:
        `Codex CLI exit code 0 but no index.html in ${appDir}. ` +
        `Most likely the ChatGPT subscription truncated the build mid-write ` +
        `(its tool-output limit is smaller than what build_app needs for a ` +
        `full single-file app). Options: (1) ask the user to switch the chat ` +
        `provider to Anthropic and retry, (2) write the file directly with ` +
        `the \`write\` tool instead of build_app, or (3) keep the prompt ` +
        `short enough that the response fits inside the subscription cap.\n\n` +
        `Tail of CLI output:\n${output.slice(-1000)}`,
      isError: true,
    };
  } catch (e) {
    const errMsg = (e as Error).message || "unknown";
    if (existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built (with warnings)!\n\nOpen: ${appUrl}\n\n${errMsg.slice(0, 300)}` };
    }
    return { content: `Codex CLI build failed: ${errMsg.slice(0, 500)}`, isError: true };
  }
}

export async function buildWithClaude(
  prompt: string,
  appDir: string,
  appUrl: string,
  onEvent?: (e: { type: string; [k: string]: unknown }) => void,
): Promise<ToolResult> {
  try {
    const { spawn: spawnChild } = await import("node:child_process");
    // stream-json + --verbose makes the CLI emit JSONL of every event during
    // the run instead of buffering the final text. Without it, build_app on
    // the Claude path is silent for 1-5 min — streamProgress has nothing to
    // throttle and the chat UI stays on "executing…" the entire time.
    const finalText = { value: "" };
    const claudeParser = (line: string): string | null => parseClaudeStreamLine(line, finalText);
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawnChild("claude", [
        "-p",
        "--output-format", "stream-json",
        "--verbose",
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
      const stopProgress = streamProgress(proc, "build_app", onEvent, 750, claudeParser);
      const timer = setTimeout(() => { proc.kill(); reject(new Error("Claude CLI build timed out after 5 minutes")); }, 300_000);
      proc.on("close", (code) => {
        clearTimeout(timer);
        stopProgress();
        if (code === 0) resolve(out);
        else reject(new Error(errOut || `Claude CLI exit code ${code}`));
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        stopProgress();
        reject(new Error(`Claude CLI not available: ${err.message}. Install with: npm install -g @anthropic-ai/claude-code`));
      });
    });

    // Prefer the parsed final text from the stream-json `result` event; fall
    // back to the raw stdout tail if the result event was missing (older CLI).
    const summary = finalText.value || stdout.trim();
    if (summary.includes("APP_READY") || existsSync(resolve(appDir, "index.html"))) {
      return { content: `App built with Claude CLI!\n\nOpen: ${appUrl}\n\n${summary.slice(-500)}` };
    }
    return { content: `Claude CLI finished but index.html not found.\n${summary.slice(-1000)}`, isError: true };
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
  <title>${title} — Local Agent X</title>
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

/**
 * self_edit — delegates source-code repair to Claude Code.
 *
 * Purpose: when the in-Local-Agent-X agent hits a bug (tool call "succeeded"
 * but outcome is wrong, UI didn't update, endpoint returns wrong shape,
 * etc.), it can call self_edit("description of the bug or change") to have
 * Claude Code read the codebase, diagnose, patch, and rebuild.
 *
 * The main agent stays in charge of high-level reasoning ("the theme
 * didn't flip visually — something's wrong") and offloads the actual
 * code surgery to a model that's specifically trained for it.
 *
 * Default flow: sandboxed.
 *   - claude -p runs inside an isolated git worktree
 *   - after it returns, three gates run: build / server-bind / agent-smoke
 *   - only if all three pass do the changes merge to main
 *   - if any fail, the worktree branch is preserved and main is untouched
 *   - this means a self_edit that breaks the agent CANNOT brick the agent
 *
 * Bypass flow: when args._cwd is set (autopilot route) OR args._unsafe is
 * true (emergency rescues), claude -p runs directly in the supplied cwd
 * without sandbox gates. _unsafe is server-injected only — not in the
 * public schema — so the model can't ask for it.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmAugmentedEnv } from "./anthropic-client/cli-path.js";
import type { ToolDefinition } from "./types.js";

const LAX_REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAX_OUTPUT_CHARS = 4000;
const TIMEOUT_MS = 10 * 60_000; // 10 min — source-code repair can be slow

/**
 * Walk up from scopeHint looking for AGENTS.md files; return their concatenated
 * contents, root-first so subtree rules override. If no scope hint, just return
 * the root AGENTS.md. Subtree files take precedence visually (listed last).
 */
async function collectSubtreeRules(scopeHint: string): Promise<string> {
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join, dirname, isAbsolute, resolve, relative } = await import("node:path");
    const resolved = scopeHint
      ? (isAbsolute(scopeHint) ? scopeHint : resolve(LAX_REPO_ROOT, scopeHint))
      : LAX_REPO_ROOT;
    // Build the list of directories from scopeHint up to repo root
    const dirs: string[] = [];
    let cur = existsSync(resolved) ? resolved : dirname(resolved);
    // If resolved is a file, start at its dir
    try { const { statSync } = await import("node:fs"); if (existsSync(resolved) && !statSync(resolved).isDirectory()) cur = dirname(resolved); } catch {}
    while (true) {
      dirs.push(cur);
      if (cur === LAX_REPO_ROOT || !cur.startsWith(LAX_REPO_ROOT)) break;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    // Ensure repo root is included
    if (!dirs.includes(LAX_REPO_ROOT)) dirs.push(LAX_REPO_ROOT);
    // Collect AGENTS.md contents (root first, then deeper subtrees)
    const parts: string[] = [];
    for (const d of dirs.reverse()) {
      const p = join(d, "AGENTS.md");
      if (existsSync(p)) {
        const rel = relative(LAX_REPO_ROOT, p).replace(/\\/g, "/") || "AGENTS.md";
        const body = readFileSync(p, "utf-8").trim();
        parts.push(`--- ${rel} ---\n${body}`);
      }
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

export const selfEditTool: ToolDefinition = {
  name: "self_edit",
  description:
    "Fix a bug in the Open Agent X codebase or make a source change. Use this when " +
    "a tool call succeeded HTTP-wise but the observable outcome is wrong (UI didn't " +
    "update, setting didn't apply, endpoint returns stale data, etc), or when the " +
    "user reports 'that didn't work' after what looked like success. Delegates the " +
    "code surgery to Claude Code with bash/read/edit access to the SAX source tree. " +
    "Returns a summary of the diagnosis + the files it changed. The SAX server must " +
    "be restarted after to pick up the changes — tell the user.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Describe the bug or requested change in plain English. Include " +
          "what you tried, what happened, and what SHOULD have happened. The more " +
          "observable detail (symptom, HTTP call, error message) the better.",
      },
      scope_hint: {
        type: "string",
        description: "Optional file or directory hint if you already know roughly " +
          "where the bug is (e.g. 'src/routes/settings.ts' or 'public/js/chat.js').",
      },
    },
    required: ["task"],
  },
  async execute(args, signal) {
    const task = String(args.task || "").trim();
    if (!task) return { content: "self_edit requires a 'task' description.", isError: true };
    const scopeHintArg = String(args.scope_hint || "").trim();
    const scopeHint = scopeHintArg ? `\n\nScope hint: ${scopeHintArg}` : "";
    // Internal (server-injected) overrides — NOT in the public tool schema:
    //   _cwd:    autopilot routes self_edit into its worktree path
    //   _unsafe: emergency rescue mode (skip the sandbox + gates)
    // The model itself can't set either — only the tool router can.
    const internalCwd = typeof args._cwd === "string" && args._cwd.trim() ? args._cwd : null;
    const unsafe = args._unsafe === true;

    // Walk up from the scope_hint path looking for AGENTS.md — include all
    // the subtree-scoped rules (src/AGENTS.md, packages/arikernel/AGENTS.md,
    // config/AGENTS.md, and the root AGENTS.md). Nearest-first, so subtree
    // rules take precedence visually.
    const subtreeRules = await collectSubtreeRules(scopeHintArg);
    const rulesBlock = subtreeRules
      ? `\n\nARCHITECTURAL RULES (follow these strictly — they encode what's allowed in this part of the tree):\n\n${subtreeRules}\n`
      : "";

    const fullPrompt =
      `You are editing the Local Agent X TypeScript codebase to fix a reported bug or implement a change.\n\n` +
      `Task: ${task}${scopeHint}${rulesBlock}\n\n` +
      `Constraints:\n` +
      `- Source is under src/. Public assets under public/. Config under config/.\n` +
      `- Build with: npm run build\n` +
      `- Do NOT commit or push — just make the edit and run the build to verify compilation.\n` +
      `- Make the MINIMUM change needed. No refactoring or unrelated cleanup.\n` +
      `- If the bug is ambiguous, diagnose first (read relevant files, grep logs at /tmp/lax-server.log), then patch.\n` +
      `- If your change breaks the build, revert it — don't leave the tree in a broken state.\n\n` +
      `When done, reply in this format (nothing else):\n` +
      `DIAGNOSIS: <one-line root cause>\n` +
      `CHANGED: <comma-separated file paths>\n` +
      `BUILD: ok | broken\n` +
      `NOTE: <anything the user needs to know, e.g. 'restart server to apply'>`;

    // Default flow: sandboxed via worktree + 3-gate validation. Skipped when
    // _cwd is set (autopilot already provides isolation) or _unsafe is set.
    if (!internalCwd && !unsafe) {
      const { runSelfEditInSandbox, formatSandboxResult } = await import("./self-edit-sandbox.js");
      const { getRuntimeConfig } = await import("./config.js");
      const authToken = getRuntimeConfig().authToken;
      const result = await runSelfEditInSandbox({
        task, scopeHint: scopeHintArg, signal,
        fullPrompt, authToken,
      });
      return { content: formatSandboxResult(result), isError: !result.ok };
    }

    // Bypass flow: write directly to the supplied cwd (autopilot worktree
    // OR LAX_REPO_ROOT for unsafe rescues). No gates.
    const subprocessCwd = internalCwd || LAX_REPO_ROOT;

    return await new Promise((resolveP) => {
      let stdout = "";
      let stderr = "";
      const proc = spawn("claude", [
        "-p",
        "--model", "claude-opus-4-7",
        "--permission-mode", "bypassPermissions",
        "--no-session-persistence",
        "--output-format", "text",
      ], {
        cwd: subprocessCwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
        env: npmAugmentedEnv(),
      });

      const abortListener = () => { try { proc.kill("SIGTERM"); } catch {} };
      signal?.addEventListener("abort", abortListener);

      const timer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch {}
      }, TIMEOUT_MS);

      proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); if (stdout.length > MAX_OUTPUT_CHARS * 3) stdout = stdout.slice(-MAX_OUTPUT_CHARS * 3); });
      proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });

      proc.on("error", (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
        resolveP({ content: `self_edit spawn error: ${e.message}`, isError: true });
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
        if (code !== 0 && !stdout.trim()) {
          resolveP({ content: `self_edit failed (exit ${code}):\n${stderr.slice(0, 600)}`, isError: true });
          return;
        }
        const output = stdout.trim().slice(0, MAX_OUTPUT_CHARS);
        resolveP({ content: output || `(no output, exit ${code})` });
      });

      proc.stdin?.write(fullPrompt);
      proc.stdin?.end();
    });
  },
};

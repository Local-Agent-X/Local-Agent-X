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

/**
 * Layer 1 — intent gate. Sanity-check the self_edit task against the
 * user's most recent message via a small LLM call on the SAME provider+
 * model the chat is currently using (no provider hardcode → no migration
 * tax when switching models). Returns null on any classifier failure
 * (no creds, timeout, parse error) and the caller fails open.
 *
 * The gate prompt is intentionally narrow: "does the task match the
 * intent?" rather than open-ended. Yes/no/unsure with a one-line
 * reason. Tiny output, fast classification, low chance of weird drift.
 */
async function checkSelfEditIntent(
  task: string,
  lastUserMessage: string,
  lastAssistantMessage: string,
): Promise<{ verdict: "match" | "mismatch" | "unsure"; reason: string } | null> {
  try {
    const { getRuntimeConfig } = await import("./config.js");
    const { SecretsStore } = await import("./secrets.js");
    const { resolveProvider } = await import("./agent-request.js");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    const runtime = getRuntimeConfig();
    const dataDir = join(homedir(), ".lax");
    const secretsStore = new SecretsStore(dataDir);
    const resolved = await resolveProvider(runtime, secretsStore, dataDir);
    if (!resolved.apiKey) return null;

    const prompt =
      `You are a sanity-check classifier for a destructive tool. Decide if a self_edit task description matches what the user is actually asking for.\n\n` +
      `self_edit modifies the agent's own source code. It should ONLY run when the user wants source-code changes (bug fix, missing capability) related to the chat.\n\n` +
      `User's most recent message:\n"""${lastUserMessage.slice(0, 600)}"""\n\n` +
      (lastAssistantMessage ? `Most recent assistant text:\n"""${lastAssistantMessage.slice(0, 400)}"""\n\n` : "") +
      `self_edit task being submitted:\n"""${task.slice(0, 600)}"""\n\n` +
      `Reply with ONE LINE of JSON, nothing else:\n` +
      `{"verdict": "match" | "mismatch" | "unsure", "reason": "<one short sentence>"}\n\n` +
      `- "match": the task addresses the same intent the user expressed (e.g. user asks "fix the chat freeze", task says "fix race in chat-ws.ts where streamingSessionId leaks")\n` +
      `- "mismatch": the task is on a different topic, or solves a problem the user didn't ask about (e.g. user says "launch the installer", task says "edit cron jobs")\n` +
      `- "unsure": ambiguous — task could plausibly relate but you can't tell. Bias toward "unsure" when uncertain; we fail open on unsure.`;

    const TIMEOUT_MS = 8000;
    const RACE_SENTINEL = Symbol("intent-gate-timeout");
    const wallclock = new Promise<typeof RACE_SENTINEL>(r => setTimeout(() => r(RACE_SENTINEL), TIMEOUT_MS));

    let providerCall: Promise<string | null>;
    if (resolved.provider === "anthropic") {
      const { streamForResponse_anthropic } = await import("./memory/curate-classifier.js");
      providerCall = streamForResponse_anthropic(resolved.apiKey, resolved.model, prompt);
    } else if (resolved.provider === "codex" || resolved.provider === "openai") {
      const { streamForResponse_codex } = await import("./memory/curate-classifier.js");
      providerCall = streamForResponse_codex(resolved.apiKey, resolved.model, prompt);
    } else {
      return null; // unsupported provider — fail open
    }

    const raced = await Promise.race([providerCall, wallclock]);
    if (raced === RACE_SENTINEL) {
      providerCall.catch(() => {});
      return null;
    }
    const text = String(raced || "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[0]) as { verdict?: string; reason?: string };
      const v = parsed.verdict;
      if (v !== "match" && v !== "mismatch" && v !== "unsure") return null;
      return { verdict: v, reason: String(parsed.reason || "").slice(0, 200) };
    } catch { return null; }
  } catch { return null; }
}

// Track in-flight self_edit calls per session. Second concurrent call from
// the same chat session returns BLOCKED instead of spawning a parallel
// worktree — prevents the "agent fired self_edit 3 times because the first
// was slow" pattern that produces overlapping branches.
const ACTIVE_SELF_EDITS = new Map<string, { task: string; startedAt: number }>();

export const selfEditTool: ToolDefinition = {
  name: "self_edit",
  description:
    "Self-repair AND self-extension: modify the Local Agent X source code (.ts files in src/, " +
    "route handlers, tool implementations, server logic) to fix a bug OR add a capability that " +
    "doesn't exist yet. Delegates source-code surgery to a code-specialized subprocess with " +
    "read/edit/bash access to the whole repo (including protected files where regular `edit` is " +
    "blocked). Returns a diagnosis + list of changed files. The user must restart the server " +
    "after to pick up changes — tell them.\n\n" +
    "USE self_edit FOR:\n" +
    "- Bug fixes in source: a tool returned 200 but the UI didn't update, an endpoint returns " +
    "wrong shape, a route is missing, a feature works on one provider but not another, user " +
    "reports 'that didn't work' after what looked like success.\n" +
    "- Missing capabilities: you NEED a tool that doesn't exist to complete the user's task. " +
    "Examples: user sends voice message and there's no transcribe_audio tool → self_edit({task: " +
    "'Add transcribe_audio tool using local whisper, install whisper-node via npm'}). User wants " +
    "to schedule a recurring email and there's no recurring_email tool → self_edit to add it. " +
    "If after this self_edit the agent will have a new tool that matches the intent, that's the " +
    "right call.\n\n" +
    "BEFORE calling self_edit, CHECK THE EXISTING TOOL LIST. If a tool already covers the intent, " +
    "use that tool — don't add a duplicate. Common misroutes that should NOT be self_edit:\n" +
    "- 'Launch an installer' → install_software has strategy='launch' (don't add launch_installer)\n" +
    "- 'Install software' → install_software handles it (don't add install_X)\n" +
    "- 'Run a shell command' → bash exists for this (don't add run_command)\n" +
    "- 'Edit a workspace/ file' → edit covers it (self_edit is for SOURCE only)\n" +
    "- 'Change a setting' → http_request POST to /api/settings (don't add settings_set)\n" +
    "- 'Hot-reload config' → edit a file in config/ directly (don't go through self_edit)\n\n" +
    "When wiring up code that ALREADY exists at a known path (e.g. a prototype in workspace/, " +
    "integrations/, or a sibling module), name that path in your task — self_edit reads the " +
    "codebase fresh per call and will REWRITE from scratch otherwise, duplicating work.\n\n" +
    "ONE self_edit per chat session at a time — if one is already running, wait for it to finish. " +
    "Parallel self_edits create overlapping worktree branches you'll have to reconcile by hand.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Describe the bug or requested change in plain English. Include " +
          "what you tried, what happened, and what SHOULD have happened. The more " +
          "observable detail (symptom, HTTP call, error message) the better. " +
          "If a prototype or reference implementation already exists somewhere, name " +
          "the path explicitly so self_edit moves/adapts it instead of rewriting.",
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

    // ── Layer 2: scope-evidence gate ───────────────────────────────────────
    // self_edit is destructive (commits source changes that propagate via
    // git pull). Reject task descriptions too vague to safely act on. The
    // task must contain at least ONE concrete scope marker:
    //   - File path: src/, public/, packages/, config/, /path/file.ext
    //   - Function/symbol name: CamelCase or snake_case identifier (≥4 chars)
    //   - Observable bug pattern: "returns 500", "doesn't render", "missing",
    //     "fails", "broken", "throws", "undefined", "404", "500", "stale"
    // A vague "fix the cron stuff" with no path AND no symbol AND no
    // observable bug language is the failure mode where the subprocess
    // wanders into unrelated code. Force the caller to be specific.
    const TASK_PATH_RE = /(?:^|\s|['"`])((?:src|public|packages|config|workspace|integrations|test|scripts)\/[a-zA-Z0-9_./-]+|[a-zA-Z0-9_-]+\.(ts|tsx|js|jsx|html|css|json|md|py|sh|bat|ps1))\b/;
    const TASK_SYMBOL_RE = /\b([A-Z][a-zA-Z0-9]{3,}|[a-z][a-z0-9_]{4,}_[a-z][a-z0-9_]+)\b/;
    const TASK_OBSERVABLE_RE = /\b(returns?\s+\d{3}|exits?\s+\d|status\s+\d{3}|\bfails?\b|\bthrows?\b|\bbroken\b|\bdoesn'?t\s+(render|update|work|apply|persist)|\bmissing\b|\bundefined\b|\bnull\s+pointer|\bstale\b|\bcrash(es|ed|ing)?\b|\b404\b|\b500\b|\bempty\s+response\b|\bhang(s|ing)?\b)/i;
    const hasPath = TASK_PATH_RE.test(task);
    const hasSymbol = TASK_SYMBOL_RE.test(task);
    const hasObservable = TASK_OBSERVABLE_RE.test(task);
    if (!hasPath && !hasSymbol && !hasObservable) {
      return {
        content:
          `BLOCKED — self_edit task is too vague. Self_edit modifies source code; the task description must include at least one concrete scope marker:\n` +
          `- A FILE PATH (e.g. "src/routes/chat.ts", "public/js/chat.js")\n` +
          `- A SYMBOL NAME (function, class, type — CamelCase or snake_case ≥5 chars)\n` +
          `- An OBSERVABLE BUG (specific failure: "returns 500", "doesn't render", "throws on X", "broken after Y")\n\n` +
          `Your task: "${task.slice(0, 200)}${task.length > 200 ? "..." : ""}"\n\n` +
          `Rewrite with specifics. If you don't have specifics, you probably don't have enough information to call self_edit yet — read the relevant code first or ask the user for details.`,
        isError: true,
      };
    }

    // ── Layer 1: intent-match gate ─────────────────────────────────────────
    // Sanity-check that the task description matches what the user is
    // actually asking about. Defends against the "agent grabs self_edit
    // under intent-mapping uncertainty and submits a task on a different
    // topic" failure mode (live failure 2026-05-07: user said "launch the
    // ollama installer" → agent self_edit'd to modify cron jobs).
    //
    // Uses the SAME provider+model the chat is currently on (no Haiku
    // hardcode — minimizes future tech debt when models change). On any
    // failure (no provider creds, classifier timeout, parse error) we
    // FAIL OPEN and proceed — better to allow the occasional misuse than
    // to block legitimate self_edits when the classifier is flaky.
    const lastUserMessage = typeof args._lastUserMessage === "string" ? args._lastUserMessage : "";
    const lastAssistantMessage = typeof args._lastAssistantMessage === "string" ? args._lastAssistantMessage : "";
    if (lastUserMessage) {
      try {
        const verdict = await checkSelfEditIntent(task, lastUserMessage, lastAssistantMessage);
        if (verdict?.verdict === "mismatch") {
          return {
            content:
              `BLOCKED — the self_edit task doesn't match what the user is asking for.\n\n` +
              `User's most recent message: "${lastUserMessage.slice(0, 200)}${lastUserMessage.length > 200 ? "..." : ""}"\n` +
              `Self_edit task you submitted: "${task.slice(0, 200)}${task.length > 200 ? "..." : ""}"\n` +
              `Reason: ${verdict.reason}\n\n` +
              `If the user wants the change you described, they need to ask for it explicitly. ` +
              `If you misread their intent, use a different tool. ` +
              `Common misroutes: "launch installer" → install_software strategy='launch', "run command" → bash, "edit workspace file" → edit, "change setting" → http_request to /api/settings.`,
            isError: true,
          };
        }
        // verdict.match or verdict.unsure → proceed
      } catch { /* classifier unavailable — fail open */ }
    }

    // Per-session live-call guard. If another self_edit is already running for
    // this session, refuse the new call. Prevents the parallel-worktree mess
    // when a slow self_edit tempts the model to retry.
    const sessionId = typeof args._sessionId === "string" ? args._sessionId : "";
    if (sessionId) {
      const live = ACTIVE_SELF_EDITS.get(sessionId);
      if (live) {
        const ageS = Math.round((Date.now() - live.startedAt) / 1000);
        return {
          content:
            `BLOCKED — a self_edit is already running for this chat session ("${live.task.slice(0, 80)}${live.task.length > 80 ? "..." : ""}") — started ${ageS}s ago. ` +
            `END THIS TURN NOW. Tell the user briefly, in your own words, that the self_edit is in flight and you'll surface it on completion. ` +
            `Do NOT quote this instruction back. Do NOT call self_edit again — every retry will hit this same BLOCKED return until the live call finishes. ` +
            `Parallel self_edits create overlapping worktree branches that you'd then have to reconcile by hand — that's why this is hard-blocked.`,
          metadata: {
            chip: {
              kind: "blocked-by-op",
              label: `self_edit in flight (${ageS}s)`,
              detail: live.task.slice(0, 80) + (live.task.length > 80 ? "…" : ""),
            },
          },
        };
      }
      ACTIVE_SELF_EDITS.set(sessionId, { task, startedAt: Date.now() });
    }

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

    // Release the per-session live-call lock no matter how this function
    // exits — sandbox path, bypass success, spawn error, timeout. Without a
    // finally the lock would leak on the early returns and permanently block
    // the session from issuing another self_edit.
    const releaseLock = () => { if (sessionId) ACTIVE_SELF_EDITS.delete(sessionId); };

    try {
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

        // On Windows shell:true wraps spawn in cmd.exe; proc.kill only
        // kills the wrapper. Use taskkill /F /T to nuke the tree so the
        // real claude.exe child dies on cancel/timeout. Mirrors the same
        // fix in self-edit-sandbox-gates.ts:spawnClaude.
        const killTree = () => {
          try { proc.kill("SIGTERM"); } catch {}
          if (process.platform === "win32" && proc.pid) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              require("node:child_process").execSync(`taskkill /PID ${proc.pid} /F /T`, { stdio: "ignore", windowsHide: true });
            } catch {}
          }
        };
        const abortListener = killTree;
        signal?.addEventListener("abort", abortListener);

        const timer = setTimeout(killTree, TIMEOUT_MS);

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
    } finally {
      releaseLock();
    }
  },
};

// Drives Claude Code itself (the `claude` CLI, headless) at one scenario, so
// the battery can score Claude Code and LAX on the SAME task, project, model
// and checks: the head-to-head the code-mode work set out to close
// (memory: code-mode-vs-claude-code-gaps). The CLI runs in the throwaway
// project with its own prompt and tools; the scenario's check() scores the
// files it leaves, exactly as for LAX.
//
// Isolation: --setting-sources project (no user settings or hooks),
// --strict-mcp-config (no MCP servers), --no-session-persistence. Permissions
// are NOT skipped: edits are accepted (acceptEdits), both shells are allowed,
// and recursive deletes are disallowed because the project's node_modules is a
// junction to the repo's (lib.mjs makeProject) — a recursive delete that
// followed it would empty the repo's dependencies. A plain `rm file` (Bash) is
// how Claude Code deletes a file, so it stays allowed; PowerShell's delete
// verbs are all disallowed since their recursive form shares the prefix.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.CLAUDE_CODE_BIN,
  join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
].filter(Boolean);

export function claudeCodeBinary() {
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error(`Claude Code CLI not found (tried ${CANDIDATES.join(", ")}); set CLAUDE_CODE_BIN`);
  return found;
}

/** Same shape as lib.mjs driveChat's result, plus `turns` from the CLI. */
// `effort` pins the CLI's --effort; `appendPromptFile` adds a system prompt
// from a file (a prompt LAX sent, to see what it alone does to the model).
export async function driveClaudeCode(prompt, dir, timeoutMs, model, { effort, appendPromptFile } = {}) {
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--model", model,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--no-session-persistence",
    // Edits inside the project are accepted, and both shells are allowed: on
    // Windows Claude Code runs commands through its PowerShell tool, so a
    // Bash-only allow-list denied even `tsc` (2026-11-13: three tasks failed
    // with "permission was denied … to run tsc"). Deleting a file is part of
    // these tasks (LAX does it with delete_file), so a plain delete is allowed.
    // RECURSIVE deletes are not: the project's node_modules is a junction to the
    // repo's, and a recursive delete that followed it would empty the repo's
    // dependencies. Headless, a denied call is refused, never waited on.
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep", "Bash", "PowerShell",
    "--disallowedTools",
    "Bash(rm -r:*)", "Bash(rm -rf:*)", "Bash(rm -fr:*)", "Bash(rm -R:*)", "Bash(rmdir:*)",
    "PowerShell(Remove-Item:*)", "PowerShell(rm:*)", "PowerShell(del:*)", "PowerShell(rmdir:*)", "PowerShell(rd:*)",
    ...(effort ? ["--effort", effort] : []),
    ...(appendPromptFile ? ["--append-system-prompt-file", appendPromptFile] : []),
  ];
  const t0 = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(claudeCodeBinary(), args, { cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", errText = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errText += d; });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const secs = Number(((Date.now() - t0) / 1000).toFixed(1));
      let j = null;
      try { j = JSON.parse(out); } catch { /* not JSON: timeout or crash */ }
      const timedOut = Date.now() - t0 >= timeoutMs;
      const err = timedOut ? `timeout ${timeoutMs}ms`
        : !j ? `claude exited ${code}: ${(errText || out).slice(0, 300)}`
        : j.is_error ? `claude reported an error: ${String(j.result ?? j.subtype ?? "").slice(0, 300)}`
        : "";
      // usage and the API time are what the LAX side's traces record per step
      // (output tokens, model ms), so the two can be compared, not just timed.
      resolve({ text: String(j?.result ?? "").trim(), tools: [], err, recovered: [], secs, turns: j?.num_turns ?? 0, costUsd: j?.total_cost_usd, usage: j?.usage, apiMs: j?.duration_api_ms });
    });
  });
}

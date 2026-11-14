// Drives Claude Code itself (the `claude` CLI, headless) at one scenario, so
// the battery can score Claude Code and LAX on the SAME task, project, model
// and checks: the head-to-head the code-mode work set out to close
// (memory: code-mode-vs-claude-code-gaps). The CLI runs in the throwaway
// project with its own prompt and tools; the scenario's check() scores the
// files it leaves, exactly as for LAX.
//
// Isolation: --setting-sources project (no user settings or hooks),
// --strict-mcp-config (no MCP servers), --no-session-persistence. Permissions
// are NOT skipped: edits are accepted (acceptEdits) and the shell is limited to
// an allow-list of the commands these tasks need. `rm` is disallowed outright
// because the project's node_modules is a junction to the repo's (lib.mjs
// makeProject) — a delete that followed it would empty the repo's dependencies.
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
export async function driveClaudeCode(prompt, dir, timeoutMs, model) {
  const args = [
    "-p", prompt,
    "--output-format", "json",
    "--model", model,
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--no-session-persistence",
    // Edits inside the project are accepted; the shell is limited to what these
    // tasks run (type-check, tests, node, search). Anything else is denied, not
    // waited on, since headless there is nobody to ask.
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "Edit", "Write", "Glob", "Grep",
    "Bash(npx tsc:*)", "Bash(npx vitest:*)", "Bash(npm test:*)", "Bash(npm run:*)",
    "Bash(node:*)", "Bash(node_modules/.bin/tsc:*)", "Bash(node_modules/.bin/vitest:*)",
    "Bash(grep:*)", "Bash(ls:*)", "Bash(cat:*)",
    "--disallowedTools", "Bash(rm:*)",
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
      resolve({ text: String(j?.result ?? "").trim(), tools: [], err, recovered: [], secs, turns: j?.num_turns ?? 0, costUsd: j?.total_cost_usd });
    });
  });
}

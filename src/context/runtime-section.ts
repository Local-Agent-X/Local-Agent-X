/**
 * The `## Runtime` prompt section: which OS and shell the `bash` tool really
 * runs, and where a relative path lands. Pure — the builder passes in what it
 * read from the same resolvers the bash tool spawns with (resolveWindowsShell,
 * workspaceRoot), so the prompt can never disagree with the tool again.
 */
import type { WindowsShellKind } from "../tools/shell-env.js";

const POSIX_VERBS =
  "Write POSIX sh: `rm`, `ls`, `mkdir -p`, `cat`, `cp`, `mv`. " +
  "NEVER `Remove-Item` / `Get-ChildItem` / `New-Item` — PowerShell cmdlets are not commands there.";

function describeShell(plat: NodeJS.Platform, winShell: WindowsShellKind | null): string {
  if (plat === "darwin") return "zsh/bash";
  if (plat !== "win32") return "bash";
  switch (winShell) {
    case "bash": return "Git Bash (POSIX sh)";
    case "pwsh": return "PowerShell 7 — no Git Bash was found; `&&`, `||`, `/dev/null` and `mkdir -p` are translated, pipes to grep/head and heredocs may fail";
    default: return "Windows PowerShell 5.1 — no Git Bash was found; `&&`, `||`, `/dev/null` and `mkdir -p` are translated, pipes to grep/head and heredocs may fail";
  }
}

export function runtimeSection(plat: NodeJS.Platform, winShell: WindowsShellKind | null, workspace: string): string {
  const friendly = plat === "darwin" ? "macOS" : plat === "win32" ? "Windows" : plat === "linux" ? "Linux" : plat;
  return `## Runtime
- Platform: ${friendly} (\`process.platform === "${plat}"\`)
- Shell behind the \`bash\` tool: ${describeShell(plat, winShell)}. ${POSIX_VERBS}
- Working directory: ${workspace} — the workspace. \`bash\` runs there and every relative path (\`notes/x.md\`) resolves there, so in a shell command never prefix a path with \`workspace/\`: that names a folder INSIDE the workspace and fails.

Reminder: file CRUD has native tools — \`read\`, \`write\`, \`edit\`, \`delete_file\`. Prefer those over shell commands. The shell-command guidance above is for the rare case where you actually need bash (process listing, git ops, build/test runs).`;
}

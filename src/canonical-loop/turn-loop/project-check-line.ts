/**
 * The project's own check, named in the per-turn digest once the request has
 * edited source (situational-awareness.ts). The command is the one the harness
 * itself would run at a done-claim (build-verify.ts, detectBuildCommand).
 *
 * Without it the model guessed which compiler was installed and wrote its own
 * fallback chain, `(command -v tsc && tsc -p . || npx -y -p typescript tsc -p .);
 * echo exit=$?`, whose output cannot say which branch ran. Parity battery
 * 2026-11-17: most closing steps then spent their thinking on "did tsc really
 * run?", about 730 tokens a run against Claude Code's plain `npx tsc --noEmit`.
 */
import { detectBuildCommand, type FsProbe } from "../../agent-guards/index.js";
import { programOnPath } from "../../tools/shell-path.js";
import { realProbe } from "./build-verify.js";

export function projectCheckLine(
  editedPaths: readonly string[],
  workspaceRoot: string,
  probe: FsProbe = realProbe,
  hasProgram: (program: string) => boolean = programOnPath,
): string | null {
  if (editedPaths.length === 0) return null;
  const detected = detectBuildCommand([...editedPaths], probe, workspaceRoot);
  if (!detected) return null;
  // A toolchain this computer lacks: naming its command would only send the
  // model to "command not found".
  if ((detected.requires ?? []).some((program) => !hasProgram(program))) return null;
  return `This project's own ${detected.kind}: \`${detected.command}\` in ${detected.cwd}. Run it as written; its exit code is the verdict.`;
}

/**
 * Done-claim structure gate for app_build ops: a project that carries the
 * structure kit (src/app-scaffold) must pass its own `check-structure` before
 * "done" is accepted — file-size ceiling, module owners, doc paths, and the
 * codebase map regenerated. A project without the kit is never held to it.
 *
 * The check is the project's own script, run by the harness through
 * executeHarnessCommand (kill switch + audit, no approval card for the
 * harness's own check). Its output is the model's fix list: the structure
 * check prints every failing check, not just the first.
 */
import { executeHarnessCommand } from "../../tool-execution/index.js";
import { structureCheckCommand } from "../../app-scaffold/project-kit.js";

const STRUCTURE_CHECK_TIMEOUT_MS = 120_000;

export type StructureGateOutcome =
  | { kind: "passed" }
  | { kind: "skipped" }
  | { kind: "failed"; detail: string };

export type StructureGateRunner = (appDir: string, opId: string, signal?: AbortSignal) => Promise<StructureGateOutcome>;

export const runAppStructureGate: StructureGateRunner = async (appDir, opId, signal) => {
  const command = structureCheckCommand(appDir);
  if (!command) return { kind: "skipped" };
  const r = await executeHarnessCommand({ command, cwd: appDir, timeoutMs: STRUCTURE_CHECK_TIMEOUT_MS, purpose: "structure-check", opId, signal });
  if (r.ok) return { kind: "passed" };
  return { kind: "failed", detail: formatStructureFailure(command, r.status, r.output) };
};

export function formatStructureFailure(command: string, status: string, output: string): string {
  const tail = output.trim().slice(-1500);
  return (
    `This build reported ready, but the project's structure check (\`${command}\`, run from the project root) ` +
    `${status === "ok" ? "failed" : `ended with status ${status}`}. The project's AGENTS.md states the rules it checks: ` +
    `no source file over the line ceiling, every folder under the source root named in ARCHITECTURE.md, every path a doc names existing. ` +
    `Fix what it lists, run it yourself, then report done again.\n\n${tail || "(no output)"}`
  );
}

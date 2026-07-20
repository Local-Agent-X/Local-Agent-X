import { stepsPlan } from "./contract.mjs";
import { runPrerequisiteSteps } from "./prerequisite-steps.mjs";
import { runCoreSteps } from "./core-steps.mjs";
import { runPosixShellStep } from "./posix-shell-step.mjs";
import { runDesktopStep } from "./desktop-step.mjs";
import { persistInstallOutcome } from "./persistence.mjs";
import { createInstallCheckpoint } from "./checkpoint.mjs";
import { verifyInstallStep } from "./step-verification.mjs";
import { createInstallRollback } from "./rollback.mjs";

const DEFAULT_STAGES = {
  prerequisites: runPrerequisiteSteps,
  core: runCoreSteps,
  posixShell: runPosixShellStep,
  desktop: runDesktopStep,
  persist: persistInstallOutcome,
};

export async function runInstaller(context, stages = DEFAULT_STAGES) {
  context.reporter.ipc({ type: "plan", steps: stepsPlan(context.platform) });
  const rollback = createInstallRollback(context);
  let reconciled;
  try { reconciled = rollback.reconcile(); }
  catch (error) { context.reporter.abort(`Installer recovery is blocked: ${error.message}`); }
  if (reconciled.restored) context.reporter.warn("Recovered the prior verified installation after an interrupted install.");
  const checkpoint = createInstallCheckpoint(context, { verifyStep: context.verifyInstallStep || verifyInstallStep });
  const restored = checkpoint.restore(context.reporter);
  if (restored.blocked) context.reporter.abort(restored.blocked);
  context.reporter.attachStepLifecycle(checkpoint);
  context.reporter.attachRequiredFailure((message) => rollback.rollback(message));
  try { rollback.begin(); }
  catch (error) {
    try { rollback.rollback(`backup preparation failed: ${error.message}`); }
    catch (restoreError) { context.reporter.abort(`Installer backup failed and recovery is ambiguous: ${restoreError.message}`); }
    context.reporter.abort(`Installer backup failed before changes were applied: ${error.message}`);
  }
  await stages.prerequisites(context);
  await stages.core(context);
  await stages.posixShell(context);
  const desktop = await stages.desktop(context);
  const persisted = stages.persist(context, desktop);
  if (persisted !== false) {
    rollback.verified();
    checkpoint.finish();
  }
}

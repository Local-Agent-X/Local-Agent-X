import { stepsPlan } from "./contract.mjs";
import { runPrerequisiteSteps } from "./prerequisite-steps.mjs";
import { runCoreSteps } from "./core-steps.mjs";
import { runPosixShellStep } from "./posix-shell-step.mjs";
import { runDesktopStep } from "./desktop-step.mjs";
import { persistInstallOutcome } from "./persistence.mjs";
import { createInstallCheckpoint } from "./checkpoint.mjs";
import { verifyInstallStep } from "./step-verification.mjs";
import { createInstallRollback } from "./rollback.mjs";
import { acquireMutationLock, releaseMutationLock } from "./transaction-lock.mjs";
import { bindInstallerDataRoot } from "./data-root.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_STAGES = {
  prerequisites: runPrerequisiteSteps,
  core: runCoreSteps,
  posixShell: runPosixShellStep,
  desktop: runDesktopStep,
  persist: persistInstallOutcome,
};

export async function runInstaller(context, stages = DEFAULT_STAGES) {
  const dataDirectory = context.dataDirectory || context.env?.LAX_DATA_DIR || process.env.LAX_DATA_DIR || join(homedir(), ".lax");
  context.dataDirectory = dataDirectory;
  const lock = await acquireMutationLock(dataDirectory, { task: "platform install" });
  if (!lock.acquired) {
    context.reporter.abort("Another installer, update, or self-edit operation is already changing this installation. Retry after it finishes.");
  }
  try {
    try { bindInstallerDataRoot(context); }
    catch (error) { context.reporter.abort(`Installer data root is unsafe: ${error.message}`); }
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
    try {
      if (!reconciled.resumed) rollback.begin(checkpoint.snapshot());
      if (rollback.enabled) checkpoint.bindUnified();
    }
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
  } finally {
    await releaseMutationLock(lock);
  }
}

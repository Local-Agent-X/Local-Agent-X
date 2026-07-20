import { stepsPlan } from "./contract.mjs";
import { runPrerequisiteSteps } from "./prerequisite-steps.mjs";
import { runCoreSteps } from "./core-steps.mjs";
import { runPosixShellStep } from "./posix-shell-step.mjs";
import { runDesktopStep } from "./desktop-step.mjs";
import { persistInstallOutcome } from "./persistence.mjs";
import { createInstallCheckpoint } from "./checkpoint.mjs";
import { verifyInstallStep } from "./step-verification.mjs";

const DEFAULT_STAGES = {
  prerequisites: runPrerequisiteSteps,
  core: runCoreSteps,
  posixShell: runPosixShellStep,
  desktop: runDesktopStep,
  persist: persistInstallOutcome,
};

export async function runInstaller(context, stages = DEFAULT_STAGES) {
  context.reporter.ipc({ type: "plan", steps: stepsPlan(context.platform) });
  const checkpoint = createInstallCheckpoint(context, { verifyStep: context.verifyInstallStep || verifyInstallStep });
  const restored = checkpoint.restore(context.reporter);
  if (restored.blocked) context.reporter.abort(restored.blocked);
  context.reporter.attachStepLifecycle(checkpoint);
  await stages.prerequisites(context);
  await stages.core(context);
  await stages.posixShell(context);
  const desktop = await stages.desktop(context);
  const persisted = stages.persist(context, desktop);
  if (persisted !== false) checkpoint.finish();
}

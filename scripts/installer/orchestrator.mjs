import { stepsPlan } from "./contract.mjs";
import { runPrerequisiteSteps } from "./prerequisite-steps.mjs";
import { runCoreSteps } from "./core-steps.mjs";
import { runPosixShellStep } from "./posix-shell-step.mjs";
import { runDesktopStep } from "./desktop-step.mjs";
import { persistInstallOutcome } from "./persistence.mjs";

const DEFAULT_STAGES = {
  prerequisites: runPrerequisiteSteps,
  core: runCoreSteps,
  posixShell: runPosixShellStep,
  desktop: runDesktopStep,
  persist: persistInstallOutcome,
};

export async function runInstaller(context, stages = DEFAULT_STAGES) {
  context.reporter.ipc({ type: "plan", steps: stepsPlan(context.platform) });
  await stages.prerequisites(context);
  await stages.core(context);
  await stages.posixShell(context);
  const desktop = await stages.desktop(context);
  stages.persist(context, desktop);
}

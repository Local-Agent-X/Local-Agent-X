import { provisionPortableGit, resolvePosixShell } from "./windows-tools.mjs";

export async function runPosixShellStep(context) {
  const { reporter, processes, platform = process.platform, env = process.env } = context;
  if (platform !== "win32") return;
  reporter.step("posixshell");
  const forceBootstrap = env.LAX_FORCE_GIT_BOOTSTRAP === "1" || env.LAX_FORCE_GIT_BOOTSTRAP === "true";
  let bash = forceBootstrap ? null : resolvePosixShell({ env });
  if (!bash) {
    reporter.log("No POSIX shell present — provisioning PortableGit…");
    bash = await provisionPortableGit(context);
  }
  if (!bash) reporter.fail("No POSIX shell (Git Bash) and PortableGit could not be provisioned. Install Git for Windows from https://git-scm.com/download/win and re-run.");
  const probe = processes.spawnSync(bash, ["-c", "echo ok | grep ok"], { encoding: "utf-8" });
  const output = `${probe.stdout || ""}${probe.stderr || ""}`.trim();
  if (probe.status !== 0 || !output.includes("ok")) {
    reporter.fail(`POSIX shell check failed — ${bash} couldn't run 'echo ok | grep ok' (exit ${probe.status}). Reinstall Git for Windows from https://git-scm.com/download/win and re-run.`);
  }
  reporter.ok(`POSIX shell verified — ${bash}`);
  reporter.stepDone("posixshell");
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The shell network cage: a dedicated sandbox account and a firewall fence
// that lets an agent shell reach only the app's egress proxy. Provisioned by
// scripts/win-cage/provision.ps1, the one implementation the app's Settings
// and the uninstaller also run. The helper binary is staged by the standalone
// installer at <installRoot>/vendor/srt-win/srt-win.exe; a developer install
// has none, so the step says so and the app falls back to the unconfined
// shell it reports truthfully.
//
// The fence permits loopback only to the egress proxy's port range, so the
// permit must name the range the app will bind. The built server chooses it
// (dist/net/shell-proxy-ports.js — the one owner, skipping ranges Windows
// reserves) and records the choice in the data dir, where the app reads it
// back at boot.
const CHOOSE_RANGE = "try { const m = await import(process.argv[1]); const r = await m.shellProxyPortRange(); process.stdout.write(`\\n${r.from}-${r.to}`); }"
  + " catch (e) { process.stderr.write(`\\n${e?.message ?? e}`); process.exit(1); }";

function chooseProxyPortRange(context, installRoot, env) {
  const { processes, dataDirectory } = context;
  const module = pathToFileURL(join(installRoot, "dist", "net", "shell-proxy-ports.js")).href;
  const result = processes.spawnSync(process.execPath, ["--input-type=module", "-e", CHOOSE_RANGE, module], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], cwd: installRoot,
    env: { ...env, ...(dataDirectory ? { LAX_DATA_DIR: dataDirectory } : {}) },
  });
  const lastLine = (text) => `${text || ""}`.trim().split("\n").slice(-1)[0].trim();
  const portRange = lastLine(result.stdout);
  if (result.status === 0 && /^\d+-\d+$/.test(portRange)) return { ok: true, portRange };
  return { ok: false, detail: lastLine(result.stderr) || `choosing the proxy's port range exited ${result.status}` };
}

export async function runWindowsCageStep(context) {
  const { reporter, processes, platform = process.platform, env = process.env, installRoot = process.cwd() } = context;
  if (platform !== "win32") return;
  if (!reporter.step("netcage", "One administrator prompt: a sandbox account and a firewall fence for agent shells")) return;
  const helper = join(installRoot, "vendor", "srt-win", "srt-win.exe");
  if (!existsSync(helper)) {
    reporter.warn("No cage helper is bundled with this install (developer build) — agent shells run unconfined until the cage is installed from Settings → Security.");
    reporter.stepDone("netcage");
    return;
  }
  const range = chooseProxyPortRange(context, installRoot, env);
  if (!range.ok) {
    reporter.warn(`The shell network cage was not installed: ${range.detail} — agent shells run unconfined until it is installed from Settings → Security.`);
    reporter.stepDone("netcage");
    return;
  }
  const script = join(installRoot, "scripts", "win-cage", "provision.ps1");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Helper", helper, "-PortRange", range.portRange];
  // The installer that staged the helper is signed by the same publisher;
  // the helper must carry that signature before it is installed machine-wide.
  if (env.LAX_INSTALLER_EXE) args.push("-SignerLike", env.LAX_INSTALLER_EXE);
  reporter.log("Provisioning the shell network cage (Windows will ask for administrator approval)…");
  const result = processes.spawnSync("powershell", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.status === 0) reporter.ok("Shell network cage installed — agent shells are confined on this machine");
  else if (result.status === 10) reporter.warn("Administrator approval was declined — agent shells run unconfined until the cage is installed from Settings → Security.");
  else reporter.warn(`The shell network cage could not be installed (exit ${result.status}${output ? `: ${output.split("\n").slice(-1)[0]}` : ""}) — agent shells run unconfined until it is installed from Settings → Security.`);
  reporter.stepDone("netcage");
}

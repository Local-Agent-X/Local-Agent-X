// Single owner of "how Local Agent X appears in Add/Remove Programs".
//
// Three bugs made an installed app impossible to remove, and all three came
// from the same root cause: the uninstall registration was written once, at
// install time, pointing INTO the tree that rolling updates replace wholesale.
//
//   1. Rolling updates swap the source tree. The generated uninstall.ps1 was
//      not part of the update payload, so it vanished. Windows then ran
//      `powershell -File <missing>`, which exits instantly — an Add/Remove
//      row that does nothing at all, with no error the user can see.
//   2. DisplayVersion was frozen at first-install and never refreshed, so the
//      entry advertised a version the install had long since moved past.
//   3. The script installer and the packaged (NSIS) installer each registered
//      their own key with no knowledge of the other, so a machine that had
//      seen both showed two rows — and neither one removed the other's files.
//
// The fix is structural, not a patch on any one symptom:
//   - the uninstaller lives OUTSIDE the updatable tree (in ~/.lax/uninstall),
//     so replacing the tree can never orphan the registration;
//   - registration is re-asserted on every boot and after every update, so a
//     missing script is re-materialised and a stale version self-corrects;
//   - exactly one key owns the machine, and whoever owns it removes every
//     component (see scripts/uninstall/lax-uninstall.*).

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync as nodeSpawnSync } from "node:child_process";

export const UNINSTALL_KEY = "LocalAgentX";
export const UNINSTALL_KEY_PATH = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_KEY}`;

/**
 * Where the uninstaller is kept so a tree swap cannot orphan it.
 *
 * ~/.lax is the data root: it survives rolling updates, reinstalls and app
 * replacement, which is exactly the lifetime the Add/Remove entry needs. The
 * script self-copies to TEMP before deleting anything, so it can still remove
 * ~/.lax itself when the user asks for a full reset.
 */
export function stableUninstallerPath(platform = process.platform, home = homedir()) {
  const name = platform === "win32" ? "lax-uninstall.ps1" : "lax-uninstall.sh";
  return join(home, ".lax", "uninstall", name);
}

/** Canonical uninstaller shipped in the source tree. */
export function sourceUninstallerPath(sourceRoot, platform = process.platform) {
  const name = platform === "win32" ? "lax-uninstall.ps1" : "lax-uninstall.sh";
  return join(sourceRoot, "scripts", "uninstall", name);
}

export function readInstalledVersion(sourceRoot) {
  try {
    return JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The packaged (electron-builder/NSIS) shell, when one is installed. */
export function packagedShellDir(platform = process.platform, env = process.env) {
  if (platform !== "win32") return null;
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) return null;
  return join(localAppData, "Programs", "local-agent-x-desktop");
}

export function packagedUninstallerExe(platform = process.platform, env = process.env) {
  const dir = packagedShellDir(platform, env);
  return dir ? join(dir, "Uninstall LocalAgentX.exe") : null;
}

/**
 * Decide what the registration SHOULD look like. Pure: no filesystem writes,
 * no registry writes — every branch is unit-testable, which matters because
 * the failure mode this guards against is invisible until a user tries to
 * uninstall months later.
 *
 * `exists` is injected so tests can describe a machine without creating one.
 */
export function planRegistration({
  sourceRoot,
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = existsSync,
  version,
} = {}) {
  const skip = (reason) => ({ action: "skip", reason });

  if (!sourceRoot) return skip("no source root");
  // A git checkout is a developer's working copy, not an installed product.
  // Registering it would put a "Local Agent X" row in Add/Remove Programs
  // whose uninstaller deletes their clone.
  if (exists(join(sourceRoot, ".git"))) return skip("source root is a git checkout");
  if (platform !== "win32") {
    // macOS/Linux have no Add/Remove Programs. We still stage the script so
    // the rescue path exists at a predictable location.
    return {
      action: "stage-only",
      scriptSource: sourceUninstallerPath(sourceRoot, platform),
      scriptTarget: stableUninstallerPath(platform, home),
    };
  }

  const packagedExe = packagedUninstallerExe(platform, env);
  const scriptTarget = stableUninstallerPath(platform, home);

  // Exactly one row owns the machine. When a packaged install is present its
  // NSIS entry is the owner (Windows created it, Windows maintains it, and its
  // customUnInstall hook calls the same script we stage here) — so we retire
  // our own key rather than racing it. Otherwise we own the row ourselves.
  if (packagedExe && exists(packagedExe)) {
    return {
      action: "retire",
      reason: "packaged install owns the Add/Remove entry",
      retireKey: UNINSTALL_KEY_PATH,
      scriptSource: sourceUninstallerPath(sourceRoot, platform),
      scriptTarget,
    };
  }

  const icon = join(sourceRoot, "public", "icon.ico");
  return {
    action: "register",
    scriptSource: sourceUninstallerPath(sourceRoot, platform),
    scriptTarget,
    keyPath: UNINSTALL_KEY_PATH,
    values: {
      DisplayName: "Local Agent X",
      DisplayVersion: version || readInstalledVersion(sourceRoot),
      DisplayIcon: exists(icon) ? icon : scriptTarget,
      Publisher: "Local Agent X",
      InstallLocation: sourceRoot,
      // Points at the STABLE copy, never into the updatable tree.
      UninstallString: `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptTarget}"`,
      QuietUninstallString: `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptTarget}" -Yes`,
    },
  };
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

/** PowerShell that writes the plan's values, or removes the retired key. */
export function buildRegistryScript(plan) {
  if (plan.action === "retire") {
    return `$k='${psQuote(plan.retireKey)}'; if (Test-Path $k) { Remove-Item -LiteralPath $k -Recurse -Force }`;
  }
  if (plan.action !== "register") return null;
  const lines = [
    `$k='${psQuote(plan.keyPath)}'`,
    `New-Item -Path $k -Force | Out-Null`,
  ];
  for (const [name, value] of Object.entries(plan.values)) {
    lines.push(`Set-ItemProperty $k ${name} '${psQuote(value)}'`);
  }
  lines.push(`Set-ItemProperty $k NoModify 1 -Type DWord`);
  lines.push(`Set-ItemProperty $k NoRepair 1 -Type DWord`);
  return lines.join("; ");
}

/**
 * Make the machine match the plan. Idempotent by construction — safe to call
 * at install time, on every app boot, and after every update. That repetition
 * IS the fix: a registration that is re-asserted cannot silently rot into the
 * do-nothing state that stranded users before.
 *
 * Never throws. A failed registration must not be able to fail an install or
 * block a boot; the worst case is the previous (working or absent) entry.
 */
export function assertUninstallRegistration({
  sourceRoot,
  platform = process.platform,
  env = process.env,
  home = homedir(),
  version,
  spawnSync = nodeSpawnSync,
  log = () => {},
} = {}) {
  try {
    const plan = planRegistration({ sourceRoot, platform, env, home, version });
    if (plan.action === "skip") return { ok: true, action: "skip", reason: plan.reason };

    // Stage the script first: both "register" and "retire" want it present, so
    // a user can always run the rescue path by hand even when no row exists.
    let staged = false;
    if (plan.scriptSource && existsSync(plan.scriptSource)) {
      mkdirSync(join(plan.scriptTarget, ".."), { recursive: true });
      copyFileSync(plan.scriptSource, plan.scriptTarget);
      staged = true;
    }

    if (plan.action === "stage-only") return { ok: true, action: "stage-only", staged };

    const script = buildRegistryScript(plan);
    if (!script) return { ok: true, action: plan.action, staged };
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: "ignore" },
    );
    const ok = result.status === 0;
    if (!ok) log(`uninstall registration exited ${result.status}`);
    return { ok, action: plan.action, staged, status: result.status };
  } catch (error) {
    log(`uninstall registration skipped: ${error.message}`);
    return { ok: false, action: "error", error: error.message };
  }
}

// Runnable directly, so the desktop shell can re-assert on boot without
// importing ESM across the CommonJS boundary (see desktop/src/uninstall-heal.ts),
// and so a user can repair a broken Add/Remove entry by hand:
//   node scripts/installer/uninstall-registration.mjs [sourceRoot]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = assertUninstallRegistration({
    sourceRoot: process.argv[2] || process.cwd(),
    log: (m) => console.warn(`[uninstall-registration] ${m}`),
  });
  console.log(`[uninstall-registration] ${JSON.stringify(result)}`);
  process.exit(result.ok ? 0 : 1);
}

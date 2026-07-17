import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { IS_WIN, PYTHON_EXE, REPO_ROOT, type VoiceTier } from "./tiers.js";
import { running } from "./state.js";

/**
 * Resolve a venv's site-packages dir. Windows puts it at a fixed path; POSIX
 * nests it under a version-specific dir (lib/python3.12/site-packages), so we
 * scan for the first python* entry. Returns null when it can't be located.
 */
export function sitePackagesDir(venvDir: string): string | null {
  if (!venvDir) return null;
  if (IS_WIN) {
    const p = join(venvDir, "Lib", "site-packages");
    return existsSync(p) ? p : null;
  }
  const libDir = join(venvDir, "lib");
  if (!existsSync(libDir)) return null;
  try {
    for (const entry of readdirSync(libDir)) {
      if (!entry.startsWith("python")) continue;
      const p = join(libDir, entry, "site-packages");
      if (existsSync(p)) return p;
    }
  } catch { /* unreadable — fall through */ }
  return null;
}

/**
 * A venv is "installed" only if its interpreter exists AND the tier's marker
 * packages are actually importable-on-disk.
 *
 * The interpreter check alone lies. `python -m venv` creates the interpreter
 * FIRST, so a venv whose `pip install` failed afterwards is left on disk
 * containing nothing but pip — and the old check reported that as "Installed".
 * The picker then enabled Start, the sidecar booted, and the user got a
 * ModuleNotFoundError crash instead of the install error that actually
 * explained it. Markers are the same modules each tier's installer verifies
 * (python/voice/_smoke.py).
 *
 * Conservative by design: a tier with no markers, or a venv whose
 * site-packages we can't locate, falls back to the interpreter check rather
 * than reporting a working install as broken.
 */
export function isInstalled(tier: VoiceTier): boolean {
  if (!existsSync(join(tier.venvDir, PYTHON_EXE))) return false;
  const markers = tier.installMarkers;
  if (!markers || markers.length === 0) return true;
  const sp = sitePackagesDir(tier.venvDir);
  if (!sp) return true;
  return markers.every(m => existsSync(join(sp, m)) || existsSync(join(sp, `${m}.py`)));
}

export async function probeHealth(url: string): Promise<{ ok: boolean; ready?: boolean; payload?: unknown }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { ok: false };
    const payload = await r.json().catch(() => ({}));
    return { ok: true, ready: !!(payload as Record<string, unknown>).ready, payload };
  } catch { return { ok: false }; }
}

export async function tierStatus(tier: VoiceTier) {
  if (tier.kind === "native") {
    const { tier4Readiness, tier4ModelDownloaded } = await import("../../../voice/tier4/index.js");
    const r = tier4Readiness();
    const m = await tier4ModelDownloaded();
    return {
      id: tier.id,
      label: tier.label,
      port: 0,
      kind: "native" as const,
      description: tier.description,
      diskFootprint: tier.diskFootprint,
      installed: r.ready,           // "installed" == npm deps resolvable
      hasInstaller: false,          // npm install handles it
      running: r.ready && m.cached, // model present means ready to use
      healthy: r.ready && m.cached, // no /healthz to probe
      pid: null,
      healthPayload: {
        modelId: r.defaultModelId,
        defaultVoice: r.defaultVoice,
        defaultDevice: r.defaultDevice,
        requestedDevice: r.requestedDevice,
        requestedDtype: r.requestedDtype,
        modelCached: m.cached,
        approxBytes: m.approxBytes,
        reason: r.reason,
      },
    };
  }

  const installed = isInstalled(tier);
  const proc = running.get(tier.id);
  const trackedRunning = !!(proc && proc.exitCode === null);
  const health = installed ? await probeHealth(tier.healthUrl) : { ok: false };
  return {
    id: tier.id,
    label: tier.label,
    port: tier.port,
    description: tier.description,
    diskFootprint: tier.diskFootprint,
    installed,
    hasInstaller: !!tier.installerPath && existsSync(tier.installerPath),
    running: trackedRunning || health.ok,
    healthy: !!health.ok && !!health.ready,
    pid: proc?.pid || null,
    healthPayload: health.payload || null,
  };
}

// Cheap "is this package on disk" check for voice-tier deps that aren't
// gated through a sidecar tier (i.e. msedge-tts, mpg123-decoder for the
// Edge cloud tier). The voice-picker UI used to render "Assumed installed"
// for these, which was misleading — this gives the picker real signal so
// users see "Installed" with a version, or "Missing — run npm install".
const VOICE_NPM_PACKAGES = ["msedge-tts", "mpg123-decoder"] as const;

export function probeVoiceNpmDeps(): Record<string, { installed: boolean; version?: string }> {
  const out: Record<string, { installed: boolean; version?: string }> = {};
  for (const pkg of VOICE_NPM_PACKAGES) {
    const pkgJsonPath = join(REPO_ROOT, "node_modules", pkg, "package.json");
    if (!existsSync(pkgJsonPath)) {
      out[pkg] = { installed: false };
      continue;
    }
    try {
      const j = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string };
      out[pkg] = { installed: true, version: j.version };
    } catch {
      out[pkg] = { installed: true };
    }
  }
  return out;
}

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME, PYTHON_EXE, REPO_ROOT, type VoiceTier } from "./tiers.js";
import { running } from "./state.js";

export function isInstalled(tier: VoiceTier): boolean {
  return existsSync(join(tier.venvDir, PYTHON_EXE));
}

// Studio-trained-specific: detect partial state where the GPT-SoVITS repo
// + trained voice weights are on disk but the venv isn't. This is the
// "venv got wiped, weights survived" state — picker shows "Weights present,
// click Rebuild" instead of the misleading "Not installed".
function studioTrainedAssetState(): { repoPresent: boolean; weightsPresent: boolean } {
  const repoDir = join(HOME, ".lax", "sovits", "repo");
  const repoPresent = existsSync(repoDir);
  if (!repoPresent) return { repoPresent: false, weightsPresent: false };
  // Any *.pth file in the SoVITS_weights* sibling dirs counts as a trained voice.
  const weightDirs = ["SoVITS_weights", "SoVITS_weights_v2", "SoVITS_weights_v2Pro", "SoVITS_weights_v2ProPlus", "SoVITS_weights_v3", "SoVITS_weights_v4"];
  let weightsPresent = false;
  for (const d of weightDirs) {
    const candidate = join(repoDir, d);
    if (!existsSync(candidate)) continue;
    try {
      if (!statSync(candidate).isDirectory()) continue;
      const items = readdirSync(candidate);
      if (items.some(name => name.toLowerCase().endsWith(".pth"))) {
        weightsPresent = true;
        break;
      }
    } catch { /* ignore unreadable dirs */ }
  }
  return { repoPresent, weightsPresent };
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
  // Studio-trained gets extra fields so the picker can distinguish:
  //   - venv missing + weights present → "Weights found, click Install to rebuild"
  //   - venv missing + no weights      → "Not installed (run training pipeline)"
  // For other tiers, leave undefined.
  const studioAssets = tier.id === "studio-trained" ? studioTrainedAssetState() : undefined;
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
    ...(studioAssets ? { repoPresent: studioAssets.repoPresent, weightsPresent: studioAssets.weightsPresent } : {}),
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

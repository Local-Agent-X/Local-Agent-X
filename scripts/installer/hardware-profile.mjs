import { arch, cpus, totalmem } from "node:os";

export const HARDWARE_PROFILE_VERSION = 1;

const MIB = 1024 ** 2;

function capture(processes, command, args) {
  try {
    const result = processes.spawnSync(command, args, {
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      windowsHide: true,
    });
    const missing = result?.error?.code === "ENOENT";
    return {
      state: missing ? "missing" : result?.status === 0 ? "ok" : "failed",
      stdout: String(result?.stdout || "").trim(),
    };
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "missing" : "failed", stdout: "" };
  }
}

function vendorFor(name) {
  if (/nvidia/i.test(name)) return "nvidia";
  if (/\b(?:amd|ati|radeon)\b/i.test(name)) return "amd";
  if (/\bintel\b/i.test(name)) return "intel";
  if (/\bapple\b/i.test(name)) return "apple";
  return "unknown";
}

function bytesFromSize(value) {
  const match = String(value || "").trim().match(/([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)\b/i);
  if (!match) return null;
  const unit = match[2].toUpperCase();
  const powers = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 };
  const base = unit.includes("I") ? 1024 : 1000;
  return Math.round(Number(match[1]) * base ** powers[unit]);
}

function parseNvidia(output) {
  return output.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(.*),\s*(\d+(?:\.\d+)?)\s*$/);
    if (!match) return null;
    return {
      name: match[1].trim(), vendor: "nvidia",
      memoryBytes: Math.round(Number(match[2]) * MIB), memoryKind: "dedicated", evidence: "nvidia-smi",
    };
  }).filter(Boolean);
}

function parseWindows(output) {
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => item?.Name).map((item) => ({
      name: String(item.Name), vendor: vendorFor(item.Name),
      memoryBytes: Number(item.AdapterRAM) > 0 ? Number(item.AdapterRAM) : null,
      memoryKind: /intel|microsoft basic/i.test(item.Name) ? "shared" : Number(item.AdapterRAM) > 0 ? "dedicated" : "unknown",
      evidence: "windows-cim",
    }));
  } catch {
    return [];
  }
}

function parseMac(output) {
  if (!output) return [];
  try {
    const entries = JSON.parse(output).SPDisplaysDataType;
    if (!Array.isArray(entries)) return [];
    return entries.filter((item) => item?._name).map((item) => {
      const memoryText = String(item.spdisplays_vram || "");
      const shared = /shared|dynamic/i.test(memoryText) || vendorFor(item._name) === "apple";
      const memoryBytes = shared ? null : bytesFromSize(memoryText);
      return {
        name: String(item._name), vendor: vendorFor(`${item._name} ${item.spdisplays_vendor || ""}`),
        memoryBytes, memoryKind: shared ? "shared" : memoryBytes ? "dedicated" : "unknown",
        evidence: "system-profiler",
      };
    });
  } catch {
    return [];
  }
}

function parseLinux(output) {
  return output.split(/\r?\n/).map((line) => {
    const match = line.match(/(?:VGA compatible controller|3D controller|Display controller):\s*(.+)$/i);
    if (!match || /nvidia/i.test(match[1])) return null;
    const name = match[1].replace(/\s*\(rev [^)]+\)\s*$/i, "").trim();
    return { name, vendor: vendorFor(name), memoryBytes: null, memoryKind: "unknown", evidence: "lspci" };
  }).filter(Boolean);
}

function mergeDevices(devices) {
  const merged = [];
  for (const device of devices) {
    const existing = merged.find((item) => item.name.toLowerCase() === device.name.toLowerCase());
    if (!existing) merged.push(device);
    else if (existing.memoryBytes === null && device.memoryBytes !== null) Object.assign(existing, device);
  }
  return merged;
}

function collectGpu(platform, processes) {
  const nvidia = capture(processes, "nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
  const precise = nvidia.state === "ok" ? parseNvidia(nvidia.stdout) : [];
  let platformProbe;
  let discovered = [];
  if (platform === "win32") {
    platformProbe = capture(processes, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"]);
    if (platformProbe.state === "ok") discovered = parseWindows(platformProbe.stdout);
  } else if (platform === "darwin") {
    platformProbe = capture(processes, "system_profiler", ["SPDisplaysDataType", "-json"]);
    if (platformProbe.state === "ok") discovered = parseMac(platformProbe.stdout);
  } else if (platform === "linux") {
    platformProbe = capture(processes, "lspci", []);
    if (platformProbe.state === "ok") discovered = parseLinux(platformProbe.stdout);
  } else {
    platformProbe = { state: "missing" };
  }
  const devices = mergeDevices([...precise, ...discovered]);
  const probeSucceeded = nvidia.state === "ok" || platformProbe.state === "ok";
  return {
    status: devices.length ? "detected" : probeSucceeded ? "not-detected" : "unknown",
    devices,
    multiGpu: devices.length > 1,
    sharedMemory: devices.some((device) => device.memoryKind === "shared"),
  };
}

function collectOllama(processes) {
  const runtime = capture(processes, "ollama", ["--version"]);
  if (runtime.state !== "ok") {
    return { status: runtime.state === "missing" ? "not-installed" : "unknown", version: null, modelsStatus: "unknown", models: [] };
  }
  const version = runtime.stdout.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\b/)?.[0] || null;
  const result = capture(processes, "ollama", ["list"]);
  if (result.state !== "ok") return { status: "installed", version, modelsStatus: "unknown", models: [] };
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const models = lines.slice(/^NAME\s+/i.test(lines[0] || "") ? 1 : 0).map((line) => {
    const columns = line.trim().split(/\t+|\s{2,}/);
    if (!columns[0]) return null;
    return { name: columns[0], sizeBytes: bytesFromSize(columns[2]) };
  }).filter(Boolean);
  return { status: "installed", version, modelsStatus: "available", models };
}

export function buildModelAdvisories(profile) {
  return profile.ollama.models.map((model) => {
    const knownDedicated = profile.gpu.devices.filter((gpu) => gpu.memoryKind === "dedicated" && gpu.memoryBytes);
    if (!model.sizeBytes) return { model: model.name, status: "unknown", reason: "model-size-unknown" };
    if (knownDedicated.some((gpu) => model.sizeBytes <= gpu.memoryBytes * 0.8)) {
      return { model: model.name, status: "compatible", reason: "single-gpu-headroom" };
    }
    if (profile.gpu.multiGpu && knownDedicated.length > 1 && model.sizeBytes <= knownDedicated.reduce((sum, gpu) => sum + gpu.memoryBytes, 0) * 0.8) {
      return { model: model.name, status: "unknown", reason: "multi-gpu-aggregation-unknown" };
    }
    if (profile.gpu.sharedMemory) return { model: model.name, status: "unknown", reason: "shared-memory-budget-unknown" };
    if (profile.gpu.status === "unknown") return { model: model.name, status: "unknown", reason: "gpu-evidence-missing" };
    if (profile.gpu.devices.length > 0 && knownDedicated.length === 0) {
      return { model: model.name, status: "unknown", reason: "gpu-memory-unknown" };
    }
    if (profile.memory.totalBytes && model.sizeBytes <= profile.memory.totalBytes * 0.6) {
      return { model: model.name, status: "degraded", reason: "system-memory-fallback" };
    }
    if (profile.memory.totalBytes) return { model: model.name, status: "degraded", reason: "memory-headroom-low" };
    return { model: model.name, status: "unknown", reason: "memory-evidence-missing" };
  });
}

export function collectHardwareProfile({ platform = process.platform, processes, osInfo = { arch, cpus, totalmem } } = {}) {
  const cpuList = (() => { try { return osInfo.cpus() || []; } catch { return []; } })();
  const totalBytes = (() => { try { const value = osInfo.totalmem(); return value > 0 ? value : null; } catch { return null; } })();
  const profile = {
    version: HARDWARE_PROFILE_VERSION,
    platform,
    arch: (() => { try { return osInfo.arch(); } catch { return "unknown"; } })(),
    cpu: { model: cpuList[0]?.model?.trim() || null, logicalCores: cpuList.length || null },
    memory: { totalBytes },
    gpu: collectGpu(platform, processes),
    ollama: collectOllama(processes),
    modelAdvisories: [],
  };
  profile.modelAdvisories = buildModelAdvisories(profile);
  return profile;
}

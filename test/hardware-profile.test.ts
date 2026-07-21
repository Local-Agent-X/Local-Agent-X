import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildModelAdvisories, collectHardwareProfile } from "../scripts/installer/hardware-profile.mjs";
import { persistInstallOutcome } from "../scripts/installer/persistence.mjs";
import { createReporter } from "../scripts/installer/reporter.mjs";

type Result = { status: number | null; stdout?: string; error?: { code: string } };

function fixture(platform: string, outputs: Record<string, Result>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const processes = {
    spawnSync: (command: string, args: string[]) => {
      calls.push({ command, args });
      return outputs[`${command} ${args.join(" ")}`] || outputs[command] || { status: null, error: { code: "ENOENT" } };
    },
  };
  const osInfo = {
    arch: () => "x64",
    cpus: () => [{ model: "Test CPU" }, { model: "Test CPU" }],
    totalmem: () => 32 * 1024 ** 3,
  };
  return { profile: collectHardwareProfile({ platform, processes, osInfo }), calls };
}

describe("portable installer hardware profile", () => {
  it("captures Windows CIM GPUs and installed Ollama models without acquisition commands", () => {
    const { profile, calls } = fixture("win32", {
      "powershell.exe": { status: 0, stdout: JSON.stringify([
        { Name: "Intel Integrated Graphics", AdapterRAM: 0 },
        { Name: "AMD Radeon", AdapterRAM: 8 * 1024 ** 3 },
      ]) },
      "ollama --version": { status: 0, stdout: "ollama version is 0.11.2" },
      "ollama list": { status: 0, stdout: "NAME            ID              SIZE      MODIFIED\nlocal:latest    abcdef          4.1 GB    2 days ago" },
    });
    expect(profile.gpu).toMatchObject({ status: "detected", multiGpu: true, sharedMemory: true });
    expect(profile.ollama).toEqual({
      status: "installed", version: "0.11.2", modelsStatus: "available",
      models: [{ name: "local:latest", sizeBytes: 4_100_000_000 }],
    });
    expect(profile.modelAdvisories).toEqual([{ model: "local:latest", status: "compatible", reason: "single-gpu-headroom" }]);
    expect(calls.map(({ command, args }) => `${command} ${args.join(" ")}`)).toEqual([
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
      expect.stringMatching(/^powershell\.exe -NoProfile -NonInteractive -Command Get-CimInstance/),
      "ollama --version",
      "ollama list",
    ]);
  });

  it("represents macOS unified memory honestly", () => {
    const { profile } = fixture("darwin", {
      system_profiler: { status: 0, stdout: JSON.stringify({ SPDisplaysDataType: [{
        _name: "Apple M4", spdisplays_vendor: "Apple", spdisplays_vram: "spdisplays_vram_shared",
      }] }) },
      "ollama --version": { status: 0, stdout: "ollama version 1.2.3" },
      "ollama list": { status: 0, stdout: "NAME  ID  SIZE  MODIFIED\nlocal  aa  5 GB  today" },
    });
    expect(profile.gpu.devices[0]).toMatchObject({ vendor: "apple", memoryBytes: null, memoryKind: "shared" });
    expect(profile.modelAdvisories[0]).toMatchObject({ status: "unknown", reason: "shared-memory-budget-unknown" });
  });

  it("keeps Linux non-NVIDIA evidence without inventing VRAM", () => {
    const { profile } = fixture("linux", {
      lspci: { status: 0, stdout: "04:00.0 VGA compatible controller: Advanced Micro Devices, Inc. Radeon RX 7800 XT (rev c8)" },
      "ollama --version": { status: 0, stdout: "ollama version 1.2.3" },
      "ollama list": { status: 0, stdout: "NAME  ID  SIZE  MODIFIED\nlocal  aa  7 GiB  today" },
    });
    expect(profile.gpu.devices).toEqual([expect.objectContaining({ vendor: "amd", memoryBytes: null, memoryKind: "unknown" })]);
    expect(profile.modelAdvisories[0]).toMatchObject({ status: "unknown", reason: "gpu-memory-unknown" });
  });

  it("keeps installed runtime identity when model inventory is unavailable", () => {
    const { profile } = fixture("linux", {
      lspci: { status: 0, stdout: "" },
      "ollama --version": { status: 0, stdout: "ollama version is 0.11.2" },
      "ollama list": { status: 1, stdout: "" },
    });
    expect(profile.ollama).toEqual({
      status: "installed", version: "0.11.2", modelsStatus: "unknown", models: [],
    });
    expect(profile.modelAdvisories).toEqual([]);
  });

  it("does not sum multiple GPUs into a compatibility claim", () => {
    const profile = {
      memory: { totalBytes: 64 * 1024 ** 3 },
      gpu: { status: "detected", multiGpu: true, sharedMemory: false, devices: [
        { memoryKind: "dedicated", memoryBytes: 8 * 1024 ** 3 },
        { memoryKind: "dedicated", memoryBytes: 8 * 1024 ** 3 },
      ] },
      ollama: { models: [{ name: "installed", sizeBytes: 12 * 1024 ** 3 }] },
    };
    expect(buildModelAdvisories(profile)).toEqual([
      { model: "installed", status: "unknown", reason: "multi-gpu-aggregation-unknown" },
    ]);
  });

  it("preserves missing tools and incomplete OS evidence as unknown", () => {
    const calls: string[] = [];
    const profile = collectHardwareProfile({
      platform: "linux",
      processes: { spawnSync: (command: string, args: string[]) => {
        calls.push(`${command} ${args.join(" ")}`);
        return { status: null, error: { code: "ENOENT" } };
      } },
      osInfo: { arch: () => "arm64", cpus: () => [], totalmem: () => 0 },
    });
    expect(profile).toMatchObject({
      arch: "arm64", cpu: { model: null, logicalCores: null }, memory: { totalBytes: null },
      gpu: { status: "unknown", devices: [] },
      ollama: { status: "not-installed", version: null, modelsStatus: "unknown", models: [] },
    });
    expect(calls).toEqual([
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
      "lspci ",
      "ollama --version",
    ]);
  });

  it("persists current advisory evidence without changing explicit selections", () => {
    const directory = mkdtempSync(join(tmpdir(), "hardware-profile-report-"));
    const hardwareProfile = fixture("linux", {
      lspci: { status: 0, stdout: "" },
      "ollama --version": { status: 0, stdout: "ollama version 1.0.0" },
      "ollama list": { status: 0, stdout: "NAME  ID  SIZE  MODIFIED" },
    }).profile;
    const reporter = createReporter({ ipcMode: true, stdout: { write: () => true } as NodeJS.WriteStream });
    const selections = { ollamaRuntime: false, ollamaMemoryModel: false };
    try {
      expect(persistInstallOutcome({ reporter, dataDirectory: directory, platform: "linux", hardwareProfile, selections }, {})).toBe(true);
      const report = JSON.parse(readFileSync(join(directory, "install-report.json"), "utf-8"));
      expect(report.hardwareProfile).toEqual(hardwareProfile);
      expect(report.selections).toEqual(selections);
      expect(report.degraded).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

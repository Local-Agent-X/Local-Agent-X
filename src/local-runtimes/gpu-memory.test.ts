import { describe, expect, it } from "vitest";
import { parseNvidiaSmi, parseRunnerPids, parseSharedUsage, readGpuMemory, readGpuUsedBytes, readRunnerSharedBytes } from "./gpu-memory.js";

const MIB = 1024 * 1024;

describe("parseNvidiaSmi", () => {
  it("reads name and memory.total (MiB)", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 5090, 32607\r\n")).toEqual({
      name: "NVIDIA GeForce RTX 5090", totalBytes: 32_607 * MIB, source: "measured",
    });
  });

  it("sums several GPUs — Ollama splits layers and their KV across them", () => {
    expect(parseNvidiaSmi("NVIDIA RTX A6000, 49140\nNVIDIA RTX A6000, 49140\n")).toEqual({
      name: "NVIDIA RTX A6000 + NVIDIA RTX A6000", totalBytes: 2 * 49_140 * MIB, source: "measured",
    });
  });

  it("keeps a comma inside the product name", () => {
    expect(parseNvidiaSmi("Quadro, Special Edition, 8192")?.name).toBe("Quadro, Special Edition");
  });

  it("is null on garbage or no GPUs", () => {
    expect(parseNvidiaSmi("")).toBeNull();
    expect(parseNvidiaSmi("No devices were found")).toBeNull();
    expect(parseNvidiaSmi("GPU, [N/A]")).toBeNull();
  });
});

describe("readGpuMemory", () => {
  it("asks nvidia-smi for name and total memory only", async () => {
    const seen: string[][] = [];
    const gpu = await readGpuMemory({
      platform: "win32",
      exec: async (file, args) => { seen.push([file, ...args]); return "NVIDIA GeForce RTX 5090, 32607\n"; },
    });
    expect(seen).toEqual([["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]]);
    expect(gpu?.totalBytes).toBe(32_607 * MIB);
  });

  it("is null when there is no NVIDIA driver (AMD, Intel, headless)", async () => {
    const gpu = await readGpuMemory({ platform: "linux", exec: async () => { throw new Error("ENOENT"); } });
    expect(gpu).toBeNull();
  });

  it("estimates two thirds of unified memory on Apple Silicon, and says so", async () => {
    expect(await readGpuMemory({ platform: "darwin", arch: "arm64", totalMemBytes: 36 * 1024 ** 3 }))
      .toEqual({ name: "Apple Silicon unified memory", totalBytes: 24 * 1024 ** 3, source: "estimated" });
  });

  it("reads VRAM in use across every GPU, for explaining a spill", async () => {
    expect(await readGpuUsedBytes({ platform: "win32", exec: async () => "30100\r\n1200\r\n" })).toBe(31_300 * MIB);
    expect(await readGpuUsedBytes({ platform: "win32", exec: async () => "[N/A]\n" })).toBeNull();
    expect(await readGpuUsedBytes({ platform: "linux", exec: async () => { throw new Error("ENOENT"); } })).toBeNull();
    expect(await readGpuUsedBytes({ platform: "darwin" })).toBeNull();
  });

  it("is null on an Intel Mac — no GPU LAX can size for", async () => {
    expect(await readGpuMemory({ platform: "darwin", arch: "x64", totalMemBytes: 64 * 1024 ** 3 })).toBeNull();
  });
});

describe("readRunnerSharedBytes — the runner's memory the driver put in system RAM (Windows)", () => {
  // Shapes copied from this machine (2026-11-05): tasklist quotes every cell,
  // memory included; typeperf names one instance per process and adapter.
  const TASKLIST = [
    '"ollama app.exe","4980","Console","1","100,848 K"',
    '"ollama.exe","22508","Console","1","69,628 K"',
    '"llama-server.exe","36884","Console","1","1,821,280 K"',
    '"dwm.exe","2616","Console","1","115,184 K"',
  ].join("\r\n");
  const TYPEPERF = [
    "",
    '"(PDH-CSV 4.0)","\\PMAJLABS\GPU Process Memory(pid_2616_luid_0x00000000_0x00011EC4_phys_0)\Shared Usage","\\PMAJLABS\GPU Process Memory(pid_36884_luid_0x00000000_0x00011EC4_phys_0)\Shared Usage","\\PMAJLABS\GPU Process Memory(pid_36884_luid_0x00000000_0x000134D1_phys_0)\Shared Usage"',
    '"11/05/2026 08:33:54.269","42266624.000000","2160000000.000000","1000.000000"',
    "Exiting, please wait...",
  ].join("\r\n");

  it("finds the runner processes, not the tray app or the desktop", () => {
    expect([...parseRunnerPids(TASKLIST)].sort()).toEqual([22508, 36884]);
  });

  it("sums the runners' columns across adapters", () => {
    expect(parseSharedUsage(TYPEPERF, new Set([22508, 36884]))).toBe(2_160_001_000);
    expect(parseSharedUsage("no data", new Set([36884]))).toBeNull();
  });

  it("reads it on Windows only, and is null without a runner or a counter", async () => {
    const exec = async (file: string) => (file === "tasklist" ? TASKLIST : TYPEPERF);
    expect(await readRunnerSharedBytes({ platform: "win32", exec })).toBe(2_160_001_000);
    expect(await readRunnerSharedBytes({ platform: "linux", exec })).toBeNull();
    expect(await readRunnerSharedBytes({ platform: "win32", exec: async () => '"dwm.exe","2616","Console","1","1 K"' })).toBeNull();
    expect(await readRunnerSharedBytes({ platform: "win32", exec: async (file) => { if (file === "typeperf") throw new Error("no counter"); return TASKLIST; } })).toBeNull();
  });
});

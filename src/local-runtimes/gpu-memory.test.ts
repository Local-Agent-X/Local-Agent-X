import { describe, expect, it } from "vitest";
import { parseNvidiaSmi, readGpuMemory, readGpuUsedBytes } from "./gpu-memory.js";

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

/**
 * How much VRAM this machine's GPU has — the one hardware fact context sizing
 * needs. Answers only what it can measure or soundly bound, never a guess
 * upward:
 *
 *   NVIDIA         nvidia-smi --query-gpu (the driver's own figure)
 *   Apple Silicon  unified memory: Metal's recommended working set is not
 *                  readable without native code, so two thirds of physical
 *                  memory — at or under the working set macOS grants a GPU
 *                  on every current configuration — marked "estimated"
 *   anything else  null (AMD, Intel, no driver tool): the caller keeps the
 *                  runtime's own default context
 *
 * Several NVIDIA GPUs are summed: Ollama splits a model's layers, and the KV
 * cache follows its layers, across every visible device.
 */
import { execFile } from "node:child_process";
import { totalmem } from "node:os";
import type { GpuMemory } from "./context-sizing-core.js";

const NVIDIA_SMI_TIMEOUT_MS = 3_000;
const MIB = 1024 * 1024;

export type ExecText = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

const execText: ExecText = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
    if (err) reject(err);
    else resolve(String(stdout));
  });
});

/** Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(stdout: string): GpuMemory | null {
  const gpus = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const cut = line.lastIndexOf(",");
    const mib = Number(line.slice(cut + 1).trim());
    return { name: line.slice(0, cut).trim(), mib };
  }).filter((g) => g.name && Number.isFinite(g.mib) && g.mib > 0);
  if (gpus.length === 0) return null;
  return {
    name: gpus.map((g) => g.name).join(" + "),
    totalBytes: gpus.reduce((sum, g) => sum + g.mib * MIB, 0),
    source: "measured",
  };
}

export interface GpuProbeDeps {
  exec?: ExecText;
  platform?: NodeJS.Platform;
  arch?: string;
  totalMemBytes?: number;
}

/** Never throws; an unreadable GPU is null. */
export async function readGpuMemory(deps: GpuProbeDeps = {}): Promise<GpuMemory | null> {
  const platform = deps.platform ?? process.platform;
  if (platform === "darwin") {
    if ((deps.arch ?? process.arch) !== "arm64") return null;
    const total = deps.totalMemBytes ?? totalmem();
    return { name: "Apple Silicon unified memory", totalBytes: Math.floor((total * 2) / 3), source: "estimated" };
  }
  try {
    const out = await (deps.exec ?? execText)(
      "nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], NVIDIA_SMI_TIMEOUT_MS,
    );
    return parseNvidiaSmi(out);
  } catch {
    return null; // no NVIDIA driver on PATH: not a failure, just not knowable
  }
}

/**
 * VRAM in use right now across NVIDIA GPUs, by every process — Ollama's
 * runners and everything else. Null where it cannot be read (no driver tool,
 * Apple unified memory). Read only when a spill needs explaining.
 */
export async function readGpuUsedBytes(deps: GpuProbeDeps = {}): Promise<number | null> {
  if ((deps.platform ?? process.platform) === "darwin") return null;
  try {
    const out = await (deps.exec ?? execText)(
      "nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], NVIDIA_SMI_TIMEOUT_MS,
    );
    const mib = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(Number);
    if (mib.length === 0 || mib.some((n) => !Number.isFinite(n) || n < 0)) return null;
    return mib.reduce((a, b) => a + b, 0) * MIB;
  } catch {
    return null;
  }
}

let cached: { at: number; value: Promise<GpuMemory | null> } | null = null;
const GPU_CACHE_MS = 10 * 60_000;

/** The machine's GPU, read at most once per ten minutes. */
export function machineGpuMemory(): Promise<GpuMemory | null> {
  if (!cached || Date.now() - cached.at > GPU_CACHE_MS) cached = { at: Date.now(), value: readGpuMemory() };
  return cached.value;
}

export function _resetGpuMemoryCacheForTests(): void {
  cached = null;
}

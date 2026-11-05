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

/** Process images that are Ollama's model runners (the serve process holds no GPU memory). */
const RUNNER_IMAGES = new Set(["llama-server.exe", "ollama.exe", "ollama_llama_server.exe"]);

/** PIDs of Ollama runner processes in `tasklist /FO CSV /NH` output. */
export function parseRunnerPids(stdout: string): Set<number> {
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const cells = line.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1));
    if (!cells || cells.length < 2 || !RUNNER_IMAGES.has(cells[0].toLowerCase())) continue;
    const pid = Number(cells[1]);
    if (Number.isInteger(pid)) pids.add(pid);
  }
  return pids;
}

/** Sum of the `pids`' columns in `typeperf "\GPU Process Memory(*)\Shared Usage" -sc 1`
 *  output (a header row naming each `pid_<n>_luid_…` instance, then one sample row). */
export function parseSharedUsage(stdout: string, pids: ReadonlySet<number>): number | null {
  const rows = stdout.split(/\r?\n/).filter((l) => l.startsWith('"'));
  if (rows.length < 2) return null;
  const cells = (row: string) => row.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1)) ?? [];
  const header = cells(rows[0]);
  const sample = cells(rows[1]);
  let sum = 0;
  header.forEach((name, i) => {
    const pid = Number(/\(pid_(\d+)_/.exec(name)?.[1]);
    const bytes = Number(sample[i]);
    if (pids.has(pid) && Number.isFinite(bytes)) sum += bytes;
  });
  return sum;
}

/**
 * System memory Ollama's runners hold for the GPU right now, on Windows: the
 * per-process "GPU Process Memory\Shared Usage" counter. When the card fills,
 * the driver places further allocations in system memory and the runner keeps
 * reporting 100% GPU, so this is the one direct reading of that spill; free
 * VRAM only hints at it. Null off Windows, with no runner, or no reading (the
 * counter names are localized on non-English Windows).
 */
export async function readRunnerSharedBytes(deps: GpuProbeDeps = {}): Promise<number | null> {
  if ((deps.platform ?? process.platform) !== "win32") return null;
  const exec = deps.exec ?? execText;
  try {
    const pids = parseRunnerPids(await exec("tasklist", ["/FO", "CSV", "/NH"], NVIDIA_SMI_TIMEOUT_MS));
    if (pids.size === 0) return null;
    const out = await exec("typeperf", ["\\GPU Process Memory(*)\\Shared Usage", "-sc", "1"], NVIDIA_SMI_TIMEOUT_MS);
    return parseSharedUsage(out, pids);
  } catch {
    return null; // no counter on this machine: the free-VRAM reading still stands
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

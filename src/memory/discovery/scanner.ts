// Memory discovery scanner.
// Walks OS-standard user data locations, identifies files that look like
// agent memory stores via content sniffing, returns ranked candidates.
// Read-only — never writes anything to disk.

import { readdirSync, statSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import { detectFile } from "./detectors.js";
import { getScanRoots, SKIP_DIR_NAMES, CANDIDATE_EXTENSIONS, hasMemoryHint } from "./scan-roots.js";
import type { DiscoveryCandidate, DiscoveryReport, ScanOptions } from "./types.js";
import { DEFAULT_SCAN_OPTIONS } from "./types.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("memory.discovery");

interface ScanState {
  filesInspected: number;
  candidates: DiscoveryCandidate[];
  perRootCandidateCount: Map<string, number>;
  options: Required<ScanOptions>;
}

function walkDirectory(
  dir: string,
  rootKey: string,
  depth: number,
  state: ScanState,
): void {
  if (depth > state.options.maxDepth) return;
  if ((state.perRootCandidateCount.get(rootKey) || 0) >= state.options.maxCandidatesPerRoot) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permission denied, etc.
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".config") continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walkDirectory(full, rootKey, depth + 1, state);
      if ((state.perRootCandidateCount.get(rootKey) || 0) >= state.options.maxCandidatesPerRoot) return;
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = extname(entry.name).toLowerCase();
    if (!CANDIDATE_EXTENSIONS.has(ext)) continue;

    inspectFile(full, rootKey, state);
    if ((state.perRootCandidateCount.get(rootKey) || 0) >= state.options.maxCandidatesPerRoot) return;
  }
}

function inspectFile(path: string, rootKey: string, state: ScanState): void {
  let stats;
  try { stats = statSync(path); } catch { return; }
  if (stats.size < state.options.minFileSize) return;
  if (stats.size > state.options.maxInspectSize) return;

  const name = basename(path);
  const ext = extname(name).toLowerCase();
  const isSQLite = ext === ".sqlite" || ext === ".sqlite3" || ext === ".db";

  // For .md/.txt without memory hints in name, skip — too noisy otherwise
  if ((ext === ".md" || ext === ".txt") && !hasMemoryHint(name) && !hasMemoryHint(basename(dirname(path)))) {
    return;
  }
  // For .json/.jsonl, only sniff if filename or parent dir hints memory,
  // OR file is larger than 10KB (worth a peek either way)
  if ((ext === ".json" || ext === ".jsonl" || ext === ".ndjson") && stats.size < 10 * 1024) {
    if (!hasMemoryHint(name) && !hasMemoryHint(basename(dirname(path)))) return;
  }

  state.filesInspected++;
  const result = detectFile(path);
  if (!result) return;

  // Boost confidence if filename/parent dir contains memory hints
  let confidence = result.confidence;
  if (hasMemoryHint(name)) confidence = Math.min(1, confidence + 0.1);
  if (hasMemoryHint(basename(dirname(path)))) confidence = Math.min(1, confidence + 0.05);
  void isSQLite;

  state.candidates.push({
    path,
    parentApp: basename(dirname(path)),
    format: result.format,
    confidence,
    estimatedRecords: result.estimatedRecords,
    fileSize: stats.size,
    lastModified: stats.mtimeMs,
    preview: result.preview,
  });
  state.perRootCandidateCount.set(rootKey, (state.perRootCandidateCount.get(rootKey) || 0) + 1);
}

export function discoverMemorySources(options: ScanOptions = {}): DiscoveryReport {
  const opts: Required<ScanOptions> = { ...DEFAULT_SCAN_OPTIONS, ...options };
  const roots = opts.roots.length > 0 ? opts.roots : getScanRoots();
  const t0 = Date.now();

  const state: ScanState = {
    filesInspected: 0,
    candidates: [],
    perRootCandidateCount: new Map(),
    options: opts,
  };

  logger.info(`[discovery] Scanning ${roots.length} root(s): ${roots.join(", ")}`);

  for (const root of roots) {
    state.perRootCandidateCount.set(root, 0);
    try {
      walkDirectory(root, root, 0, state);
    } catch (e) {
      logger.warn(`[discovery] Walk failed for ${root}: ${(e as Error).message}`);
    }
  }

  // Rank: confidence desc, then estimated records desc, then mtime desc
  state.candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.estimatedRecords !== a.estimatedRecords) return b.estimatedRecords - a.estimatedRecords;
    return b.lastModified - a.lastModified;
  });

  const durationMs = Date.now() - t0;
  logger.info(`[discovery] Done. Inspected ${state.filesInspected} files, found ${state.candidates.length} candidates in ${durationMs}ms`);

  return {
    rootsScanned: roots,
    filesInspected: state.filesInspected,
    candidates: state.candidates,
    durationMs,
  };
}

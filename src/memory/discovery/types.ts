// Memory discovery — shared types.
// Discovery walks user filesystem locations, identifies files that look like
// agent memory stores, and reports candidates back. Never writes anything.

export interface DiscoveryCandidate {
  path: string;            // absolute path to the file
  parentApp: string;       // immediate parent folder name (the app/tool that owns it)
  format: string;          // detected format id (e.g. "chatgpt", "sqlite-messages")
  confidence: number;      // 0..1 — how sure the detector is
  estimatedRecords: number; // approx number of conversations or messages
  fileSize: number;        // bytes
  lastModified: number;    // epoch ms
  preview?: string;        // short sample (first record summary) — populated for top candidates only
}

export interface DiscoveryReport {
  rootsScanned: string[];
  filesInspected: number;
  candidates: DiscoveryCandidate[];
  durationMs: number;
}

export interface ScanOptions {
  // Override scan roots (default: OS-standard user data locations)
  roots?: string[];
  // Maximum directory depth from each root (default: 4)
  maxDepth?: number;
  // Maximum candidate files per root (default: 50) — bail early on huge trees
  maxCandidatesPerRoot?: number;
  // Minimum file size in bytes (default: 1024) — skip empty/trivial files
  minFileSize?: number;
  // Maximum file size in bytes to inspect content of (default: 200MB)
  maxInspectSize?: number;
  // Whether to populate preview field for top candidates (default: true)
  generatePreviews?: boolean;
}

export const DEFAULT_SCAN_OPTIONS: Required<ScanOptions> = {
  roots: [],
  maxDepth: 4,
  maxCandidatesPerRoot: 50,
  minFileSize: 1024,
  maxInspectSize: 200 * 1024 * 1024,
  generatePreviews: true,
};

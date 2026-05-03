// Memory discovery — public API
// Walks the user's filesystem for memory-shaped files in a read-only pass
// and returns ranked candidates. Pair with conversation-ingest to commit.

export { discoverMemorySources } from "./scanner.js";
export type { DiscoveryCandidate, DiscoveryReport, ScanOptions } from "./types.js";
export { getScanRoots } from "./scan-roots.js";

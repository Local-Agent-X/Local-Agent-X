import type { ChildProcess } from "node:child_process";

// Shared so detection.tierStatus can report pid/running without pulling in
// process-control (which itself depends on detection.probeHealth for the
// adopt-existing-sidecar path).
export const running: Map<string, ChildProcess> = new Map();

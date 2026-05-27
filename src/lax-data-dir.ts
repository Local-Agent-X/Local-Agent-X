// Centralized resolver for the LAX data directory.
//
// Honors `LAX_DATA_DIR` env var so non-default deployments (tests, CI,
// containers, multi-user setups) can relocate state. Falls back to
// `~/.lax` on the user's home directory.
//
// Why this exists: ~80 modules used to inline `join(homedir(), ".lax")`
// at module load, silently ignoring LAX_DATA_DIR. That made
// non-default configs split brain — some subsystems wrote to the env
// path, others to `~/.lax`. Routing every callsite through one helper
// fixes that, and gives us one place to change the default.

import { homedir } from "node:os";
import { join } from "node:path";

export function getLaxDir(): string {
  return process.env.LAX_DATA_DIR || join(homedir(), ".lax");
}

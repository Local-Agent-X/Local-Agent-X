/**
 * Naming + probe-port helpers for the self_edit sandbox.
 *
 * Split from self-edit-sandbox.ts to keep both files under the 400-LOC limit.
 * Pure helpers only — no confinement, spawn, or path-bounding logic lives here.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:net";

// ── Config ─────────────────────────────────────────────────────────────────

const PROBE_PORT_MIN = 7100;
const PROBE_PORT_MAX = 7999;

// ── Naming + port ─────────────────────────────────────────────────────────

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "edit";
}

export function nowSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Resolve to true if nothing currently holds `port` on 127.0.0.1. */
function isProbePortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Pick a FREE probe port. Hashing pid+time alone (the old behavior) could hand
 * two concurrent probes — e.g. a sandbox bind gate and an autopilot end-of-shift
 * boot proof, which don't share the global lock — the same port. The loser then
 * either fails with a false "did not bind" or, worse, the bind poll hits the
 * OTHER probe and reports a false PASS. We start at the hashed offset (keeps
 * probes spread across the range) and walk forward to the first port nothing is
 * listening on. A tiny TOCTOU window remains between this check and the probe's
 * own listen; the bind gate's exit-code check still catches an EADDRINUSE there.
 */
export async function pickProbePort(): Promise<number> {
  const span = PROBE_PORT_MAX - PROBE_PORT_MIN;
  const h = createHash("sha1").update(`${process.pid}-${Date.now()}`).digest();
  const start = h.readUInt16BE(0) % span;
  for (let i = 0; i < span; i++) {
    const port = PROBE_PORT_MIN + ((start + i) % span);
    if (await isProbePortFree(port)) return port;
  }
  return PROBE_PORT_MIN + start; // whole range busy — let the bind gate surface it
}

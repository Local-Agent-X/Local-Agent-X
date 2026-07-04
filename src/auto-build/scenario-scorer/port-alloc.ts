/**
 * Pure per-worker dev-server port allocation.
 *
 * Stage 2 runs multiple auto-build chunk-gates in PARALLEL, each spinning
 * up the project's dev server to smoke/score it. The launch spec pins a
 * single fixed port (from `.lax-launch.json` `ready_url`), so two parallel
 * workers sharing that port collide — EADDRINUSE, or worse, one silently
 * scores the OTHER worker's server. Each parallel worker needs a DISTINCT
 * port.
 *
 * This module owns "which port for which worker". It is intentionally PURE
 * (no IO, no Date, no random) so it is deterministic and trivially
 * unit-testable. A "is this port actually free" probe is IO and belongs in
 * a SEPARATE impure helper — do NOT add IO here.
 *
 * Back-compat is load-bearing: worker 0 (the serial single-build path that
 * exists today) returns the base port and the ORIGINAL url string verbatim,
 * so nothing downstream can observe a change.
 */

/** Fallback base port when the launch spec's `ready_url` carries no explicit port. */
export const DEFAULT_BASE_PORT = 3000;

export interface PortAllocation {
  /** Port this worker's dev server should bind. */
  port: number;
  /** `ready_url` rewritten to `port` (protocol/host/path preserved). Poll THIS. */
  url: string;
}

/**
 * Deterministic port for `workerIndex`:
 *   - worker 0 / undefined / <= 0 → base port, original url returned verbatim
 *     (serial path is byte-identical to today)
 *   - worker N > 0                → base + N, url rewritten to that port
 *
 * `baseUrl` is the launch spec's `ready_url`. A missing or unparseable base
 * port defaults to {@link DEFAULT_BASE_PORT}. An unparseable url still yields
 * an allocated port but leaves the url unchanged (documented gap: a
 * ready_url we can't parse can't be safely re-pointed).
 */
export function allocatePort(baseUrl: string, workerIndex = 0): PortAllocation {
  const parts = splitUrlPort(baseUrl);
  const basePort = parts?.port ?? DEFAULT_BASE_PORT;

  // Serial / single-worker path: touch nothing — same port, same url string.
  if (!Number.isFinite(workerIndex) || workerIndex <= 0) {
    return { port: basePort, url: baseUrl };
  }

  const port = basePort + Math.floor(workerIndex);
  if (!parts) {
    // baseUrl wasn't a recognizable http(s)-style url, so we can't splice a
    // new port into it without risking a broken poll target. Report the
    // allocated port but leave the url as-is.
    return { port, url: baseUrl };
  }
  return { port, url: `${parts.head}:${port}${parts.rest}` };
}

interface UrlPortParts {
  /** protocol + host, e.g. "http://localhost" (no trailing port). */
  head: string;
  /** path + query + hash, e.g. "/app?x=1" or "". */
  rest: string;
  /** explicit port if the url carried one, else undefined. */
  port?: number;
}

// scheme://host  (:port)?  (/path | ?query | #hash)?
// Host stops at the first ':' '/' '?' '#', so the optional port group is the
// authority port only. String-spliced (not URL.toString()) to avoid trailing-
// slash normalization — we change ONLY the port, nothing else.
const URL_PORT_RE = /^([a-zA-Z][\w+.-]*:\/\/[^/:?#]+)(?::(\d+))?([/?#].*)?$/;

function splitUrlPort(url: string): UrlPortParts | null {
  const m = URL_PORT_RE.exec(url.trim());
  if (!m) return null;
  const port = m[2] !== undefined ? Number(m[2]) : undefined;
  return {
    head: m[1],
    rest: m[3] ?? "",
    port: port !== undefined && Number.isFinite(port) ? port : undefined,
  };
}

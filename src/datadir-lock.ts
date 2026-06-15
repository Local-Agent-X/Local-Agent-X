// Self-cleaning, single-instance lock keyed to the data-dir (~/.lax).
//
// Why a loopback port and not the pidfile: server.pid is a mutable file that
// only ever names the LAST writer, and a force-kill (taskkill /F) or crash
// leaves it pointing at a dead PID — so a second server (e.g. an LAX_PORT
// launch against the same ~/.lax) reads it as "stale, proceed" and boots
// anyway. Two servers then share one ~/.lax: duplicate cron runs, contended
// SQLite, and a core each. A loopback TCP port is the one cross-platform lock
// the OS reclaims the instant the holder dies — clean exit, crash, OR
// taskkill /F — so it can never go stale and can never name the wrong PID.
//
// Scope is per data-dir: the port is derived from the data-dir path, so two
// servers on the same ~/.lax contend for the same port (second refuses) while
// a deliberate second instance with its own LAX_DATA_DIR hashes elsewhere and
// is unaffected.

import { createServer, connect, type Server } from "node:net";
import { createHash } from "node:crypto";
import { createLogger } from "./logger.js";

const logger = createLogger("datadir-lock");

// Banner a holder sends to a probing second instance, so we can tell "another
// LAX server owns this data-dir" from "an unrelated service happened to grab
// our hashed port". Versioned in case the handshake ever changes.
const LOCK_MAGIC = "LAX-DATADIR-LOCK-v1";

/**
 * Deterministic loopback port for a data-dir. Range 20000-29999 sits below
 * both Linux's (32768+) and Windows' (49152+) ephemeral ranges, so an
 * outbound connection can't transiently squat the lock port. A rare collision
 * with an unrelated registered service is harmless — the probe below treats a
 * non-LAX holder as "fail open". Pure: exported for tests.
 */
export function dataDirLockPort(dir: string): number {
  const h = createHash("sha256").update(dir).digest();
  return 20000 + (h.readUInt16BE(0) % 10000);
}

/**
 * Connect to a held lock port and decide whether the holder is a LAX server
 * (sent the magic banner) or some unrelated process. Never throws; resolves
 * false on any error/timeout. Exported for tests.
 */
export function probeLockHolder(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let buf = "";
    let settled = false;
    const sock = connect({ port, host: "127.0.0.1" });
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    sock.setTimeout(2000);
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes(LOCK_MAGIC)) finish(true);
    });
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
    sock.on("close", () => finish(buf.includes(LOCK_MAGIC)));
  });
}

/**
 * Acquire the single-instance lock for `dir`. Resolves with the held server
 * (we are the sole instance — keep the handle for the process lifetime) or
 * null when we couldn't take the lock but boot must proceed anyway.
 *
 * If the port is already held by ANOTHER LAX server, this calls
 * process.exit(75) (EX_TEMPFAIL — the launcher can retry once the other
 * exits). Any other condition fails open: a bind error for a non-EADDRINUSE
 * reason, or an EADDRINUSE whose holder doesn't speak our handshake, must
 * never block boot.
 */
export function acquireDataDirLock(dir: string): Promise<Server | null> {
  const port = dataDirLockPort(dir);
  return new Promise<Server | null>((resolve) => {
    const srv = createServer((sock) => {
      // Identify ourselves to a probing second instance, then hang up.
      try { sock.end(LOCK_MAGIC + "\n"); } catch { /* ignore */ }
    });
    srv.unref(); // the lock must never keep the process alive on its own
    srv.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        void probeLockHolder(port).then((isLax) => {
          if (isLax) {
            logger.error(
              `[datadir-lock] Refusing to start — another LAX server already owns this data-dir ` +
              `(${dir}, lock port ${port}). Stop it first, or set LAX_DATA_DIR for a separate instance.`,
            );
            process.exit(75); // EX_TEMPFAIL — recoverable once the other exits
          }
          logger.warn(`[datadir-lock] lock port ${port} held by a non-LAX process — proceeding without the lock`);
          resolve(null);
        });
        return;
      }
      logger.warn(`[datadir-lock] lock bind failed (${err.code ?? err.message}) — proceeding without it`);
      resolve(null);
    });
    srv.listen(port, "127.0.0.1", () => {
      logger.info(`[datadir-lock] acquired (port ${port})`);
      resolve(srv);
    });
  });
}

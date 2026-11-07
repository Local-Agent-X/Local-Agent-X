/**
 * A login startup file the Linux cage could not protect, because it did not
 * exist yet, is moved aside once the caged command that created it exits.
 *
 * bwrap binds each existing persistence location read-only over itself
 * (bwrap.ts). One that does not exist cannot be bound: bwrap would create it on
 * the host to mount over it, and an empty ~/.bash_profile alone stops bash
 * reading ~/.profile. So with only ~/.profile present, a caged shell could
 * write ~/.bash_profile, which runs at the next login (GHSA-9mv6-qrfm-f5wv).
 * The same holds for a startup folder (~/.config/autostart, systemd user
 * units) that does not exist yet.
 *
 * So the spawn notes which locations are missing, and when the command exits,
 * any that now exist were created while it ran: each is renamed beside itself
 * (`.lax-blocked-<time>`), which no shell or service manager reads, and logged.
 * Renamed, never deleted: the user may want it back. The cage already makes
 * every existing one read-only, so a shell has no legitimate write here; the
 * file tools ask the user before writing one (persistence-locations.ts).
 *
 * A process the command left running in the background is not watched past
 * the command's own exit.
 */
import { existsSync, realpathSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cagePersistenceLocations } from "../security/layer/persistence-locations.js";
import { createLogger } from "../logger.js";

const logger = createLogger("sandbox.created-persistence");

export interface PersistenceFs {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
}

const realFs: PersistenceFs = { exists: existsSync, rename: renameSync };

export interface PersistenceWatch {
  /** Move aside every watched location that exists now; returns where each went. */
  settle(): Array<{ path: string; movedTo: string }>;
}

function realHome(home: string): string {
  try { return realpathSync(home); } catch { return home; }
}

/** Note the persistence locations under `home` that do not exist yet. */
export function watchMissingPersistence(
  home: string = homedir(),
  fs: PersistenceFs = realFs,
  now: () => Date = () => new Date(),
): PersistenceWatch {
  const root = realHome(home);
  const { files, dirs } = cagePersistenceLocations(root);
  const missing = [...files, ...dirs].map((rel) => join(root, rel)).filter((p) => !fs.exists(p));
  return {
    settle() {
      const moved: Array<{ path: string; movedTo: string }> = [];
      for (const path of missing) {
        if (!fs.exists(path)) continue;
        const movedTo = `${path}.lax-blocked-${now().toISOString().replace(/[:.]/g, "-")}`;
        try {
          fs.rename(path, movedTo);
          moved.push({ path, movedTo });
          logger.warn(`[cage] a caged command created ${path}, which runs at login; moved it to ${movedTo}`);
        } catch (e) {
          logger.error(`[cage] a caged command created ${path}, which runs at login, and it could not be moved aside: ${(e as Error).message}`);
        }
      }
      return moved;
    },
  };
}

import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

/**
 * Self-heal a wedged/legacy update-rollback journal so OTA updates can proceed.
 *
 * The wedge: installBase/stateBase/manifestCommitment were added to the rollback
 * journal schema WITHOUT bumping its version, so a pre-schema journal still
 * claims version 1 but fails the payload's validation. The payload's read() then
 * threw "ambiguous provenance", and begin() calls read() first, so EVERY OTA
 * update wedged forever. The payload carries its own fix now, but a wedged box
 * can't receive it — the OTA is the very thing that's stuck.
 *
 * This runs in the LOADER, the one component the native installer refreshes and
 * which executes before the (possibly stale) on-disk payload. Clearing the bad
 * journal here breaks the cycle: the payload's OTA then proceeds and pulls its
 * own fix on the next check.
 *
 * Conservative by construction: only removes a journal that is present AND is
 * NOT a current-schema journal — i.e. it is missing a string manifestCommitment
 * or an installBase, or does not parse at all. A structurally-current journal
 * (a real in-flight transaction) is left untouched for the payload's own
 * recovery. Pure w.r.t. its `laxDir` argument and never throws — a self-heal
 * must never crash startup; worst case the box stays exactly as wedged as before.
 *
 * Returns true iff a stale journal was removed.
 */
export function healWedgedRollbackJournal(laxDir: string): boolean {
  try {
    const dir = join(laxDir, "update-rollback");
    const journalPath = join(dir, "transaction.json");
    if (!existsSync(journalPath)) return false;
    let stale = true;
    try {
      const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
        manifestCommitment?: unknown;
        installBase?: unknown;
      };
      // A current-schema journal carries both a string manifestCommitment and an
      // installBase. If either is absent it is the legacy/broken shape that wedges.
      stale = typeof journal?.manifestCommitment !== "string" || journal?.installBase == null;
    } catch {
      stale = true; // unparseable → definitely not a usable transaction
    }
    if (!stale) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

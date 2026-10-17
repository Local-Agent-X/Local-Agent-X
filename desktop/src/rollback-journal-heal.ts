import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { dirname } from "path";
import { rollbackDir, rollbackJournalPath, supersededRollbackDir } from "./contract/data-dir.js";
import { validJournal } from "./contract/rollback-journal.js";

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
 * which executes before the (possibly stale) on-disk payload. Moving the bad
 * journal aside here breaks the cycle: the payload's OTA then proceeds and pulls
 * its own fix on the next check.
 *
 * Judged by the writer's own rule: a journal `validJournal` accepts (the server's
 * validator, contract/rollback-journal.ts) is a real in-flight transaction and is
 * left for the payload's own recovery; anything else — a pre-schema shape, a
 * tampered commitment, unparseable bytes — is moved aside. Moved, never deleted:
 * the folder also holds the backups of every file the update touched, and a
 * misjudged journal must not cost them. Never throws — a self-heal must never
 * crash startup; worst case the box stays exactly as wedged as before.
 *
 * Returns the archive path when a journal was moved aside, else null.
 */
export function healWedgedRollbackJournal(laxDir: string): string | null {
  try {
    const journalPath = rollbackJournalPath(laxDir);
    if (!existsSync(journalPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(journalPath, "utf-8"));
    } catch {
      parsed = null; // unparseable → definitely not a usable transaction
    }
    if (validJournal(parsed)) return null;
    const archive = supersededRollbackDir(laxDir, `heal-${Date.now()}`);
    mkdirSync(dirname(archive), { recursive: true });
    renameSync(rollbackDir(laxDir), archive);
    return archive;
  } catch {
    return null;
  }
}

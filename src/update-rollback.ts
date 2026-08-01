import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createJournal, directoryIdentity, durableJson, hash, parseJson, safePathChain, safeRelative, sameIdentity, samePath,
  UPDATE_ROLLBACK_ANCHOR, UPDATE_ROLLBACK_VERSION, validAnchor, validJournal,
  type TransactionAnchor, type UpdateRollbackEntry, type UpdateRollbackJournal,
} from "./update-rollback-state.js";

export type { UpdateRollbackEntry, UpdateRollbackJournal } from "./update-rollback-state.js";

async function digest(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }

export class UpdateRollbackTransaction {
  readonly directory: string;
  readonly journalPath: string;
  readonly backupRoot: string;

  constructor(private readonly stateRoot: string, private readonly fault: (point: string) => void = () => {}) {
    this.directory = join(stateRoot, "update-rollback");
    this.journalPath = join(this.directory, "transaction.json");
    this.backupRoot = join(this.directory, "artifacts");
  }

  async read(expectedInstallRoot?: string): Promise<UpdateRollbackJournal | null> {
    let raw: unknown = null;
    let journalPresent = false;
    try { raw = JSON.parse(await readFile(this.journalPath, "utf-8")); journalPresent = true; }
    catch (error) {
      try { await lstat(this.journalPath); journalPresent = true; } catch { /* absent */ }
      if (journalPresent && !expectedInstallRoot) throw this.ambiguous(error);
    }
    const claimedRoot = validJournal(raw) ? raw.installRoot : null;
    const installRoot = expectedInstallRoot ? resolve(expectedInstallRoot) : claimedRoot;
    if (!installRoot) {
      if (!journalPresent) return null;
      // Present but structurally-invalid journal with no resolvable install root
      // (e.g. a pre-schema journal whose version was never bumped when
      // installBase/stateBase/manifestCommitment were added) and no anchor to
      // check against — an orphaned/legacy artifact, not a provenance conflict.
      // Discard it so updates can proceed instead of wedging forever.
      return await this.discardOrphanedJournal("invalid journal, no install root");
    }
    const anchorPath = join(installRoot, UPDATE_ROLLBACK_ANCHOR);
    let anchor: unknown;
    try { anchor = parseJson(anchorPath); }
    catch (error) {
      if (!existsSync(anchorPath)) {
        if (!journalPresent) return null;
        // A present journal that does not structurally validate, with no anchor to
        // witness a real transaction, is an orphaned/legacy artifact — discard it
        // rather than hard-error. A VALID journal with a missing anchor is genuinely
        // ambiguous and still refuses below.
        if (!validJournal(raw)) return await this.discardOrphanedJournal("invalid journal, no anchor");
      }
      throw this.ambiguous(error);
    }
    if (!validAnchor(anchor)) throw this.ambiguous();
    this.assertJournal(anchor.journal, installRoot);
    if (journalPresent && !validJournal(raw)) throw this.ambiguous();
    const current = hash(anchor.journal);
    const received = validJournal(raw) ? hash(raw) : null;
    if (received !== current) {
      if (received !== null && received !== anchor.previousCommitment) throw this.ambiguous();
      this.assertPath(anchor.journal, this.stateRoot, join("update-rollback", "transaction.json"));
      await mkdir(this.directory, { recursive: true });
      this.assertPath(anchor.journal, this.stateRoot, join("update-rollback", "transaction.json"));
      durableJson(this.journalPath, anchor.journal);
    }
    return anchor.journal;
  }

  async archiveSupersededByCompletedInstall(expectedInstallRoot: string): Promise<boolean> {
    const root = resolve(expectedInstallRoot);
    let journalValue: unknown;
    try {
      this.assertRawPath(this.stateRoot, join("update-rollback", "transaction.json"), "journal");
      journalValue = parseJson(this.journalPath);
    } catch { return false; }
    if (!validJournal(journalValue) || !samePath(journalValue.installRoot, root)
      || !samePath(journalValue.stateRoot, this.stateRoot)) return false;

    let currentInstall;
    let currentState;
    try {
      currentInstall = directoryIdentity(root);
      currentState = directoryIdentity(this.stateRoot);
    } catch { return false; }
    if (!sameIdentity(journalValue.stateBase, currentState)
      || sameIdentity(journalValue.installBase, currentInstall)
      || currentInstall.birthtimeMs <= journalValue.installBase.birthtimeMs) return false;

    const anchorPath = join(root, UPDATE_ROLLBACK_ANCHOR);
    try { await lstat(anchorPath); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }

    const receiptPath = join(this.stateRoot, "installed-source.json");
    let receipt: unknown;
    try {
      this.assertRawPath(this.stateRoot, "installed-source.json", "receipt");
      receipt = parseJson(receiptPath);
    } catch { return false; }
    const installed = receipt as { commit?: unknown; updatedAt?: unknown } | null;
    if (!installed || typeof installed.commit !== "string" || !/^[0-9a-f]{40}$/.test(installed.commit)
      || typeof installed.updatedAt !== "string") return false;
    const startedAt = Date.parse(journalValue.startedAt);
    const updatedAt = Date.parse(installed.updatedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt) || updatedAt <= startedAt
      || updatedAt < currentInstall.birthtimeMs) return false;

    const archive = join(this.stateRoot, `update-rollback.superseded-${journalValue.id}`);
    if (existsSync(archive)) return false;
    this.assertRawPath(this.stateRoot, "update-rollback", "journal");
    this.assertRawPath(this.stateRoot, `update-rollback.superseded-${journalValue.id}`, "archive");
    const currentJournal = parseJson(this.journalPath);
    if (!validJournal(currentJournal) || hash(currentJournal) !== hash(journalValue)) return false;
    await rename(this.directory, archive);
    return true;
  }

  async begin(installRoot: string, previousVersion: string, targetVersion: string, paths: string[]): Promise<void> {
    const root = resolve(installRoot);
    const installBase = directoryIdentity(root);
    await this.ensureStateRoot();
    if (await this.read(root)) throw new Error("An update rollback transaction is already pending.");
    const stateBase = directoryIdentity(this.stateRoot);
    const ordered = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
    if (new Set(ordered.map((path) => path.toLocaleLowerCase("en-US"))).size !== ordered.length) {
      throw new Error("Update rollback paths collide under Windows path semantics.");
    }
    const entries: UpdateRollbackEntry[] = [];
    for (const path of ordered) {
      if (!safeRelative(path) || path.toLocaleLowerCase("en-US") === UPDATE_ROLLBACK_ANCHOR.toLocaleLowerCase("en-US")) throw new Error(`Unsafe update path '${path}'.`);
      this.assertRawPath(root, path, "install");
      const source = resolve(root, path);
      try {
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Update target is not a regular file: ${path}`);
        entries.push({ path, existed: true, sha256: await digest(source) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") entries.push({ path, existed: false, sha256: null });
        else throw error;
      }
    }
    let journal = createJournal(root, resolve(this.stateRoot), previousVersion, targetVersion, entries, installBase, stateBase);
    this.assertRawPath(this.stateRoot, join("update-rollback", "artifacts"), "backup");
    await mkdir(this.backupRoot, { recursive: true });
    await this.persist(journal, null);
    this.fault("after-backup-journal");
    // The journal is immutable for this phase. Validate its complete binding
    // once, then keep the per-entry path and digest checks below. Revalidating
    // every journal entry for every copied file makes large source updates
    // quadratic (12k files meant hours of CPU with no visible progress).
    this.assertBound(journal);
    const backupComplete: string[] = [];
    for (const entry of entries) {
      if (!entry.existed) continue;
      this.assertEntryPaths(journal, entry);
      await mkdir(dirname(join(this.backupRoot, entry.path)), { recursive: true });
      this.assertEntryPaths(journal, entry);
      await this.copyNoFollow(join(root, entry.path), join(this.backupRoot, entry.path), entry.sha256!, journal, entry);
      backupComplete.push(entry.path);
      this.fault(`after-backup-entry:${entry.path}`);
    }
    await this.transition(journal, { ...journal, status: "active", backupComplete });
    this.fault("after-backup");
  }

  async markApplied(targetVersion: string): Promise<void> {
    const journal = await this.require(targetVersion);
    await this.transition(journal, { ...journal, status: "applied" });
    this.fault("after-applied");
  }

  async markVerified(targetVersion: string): Promise<void> {
    const journal = await this.require(targetVersion);
    await this.transition(journal, { ...journal, status: "verified" });
    this.fault("after-verified");
  }

  async restore(installRoot: string, targetVersion: string, reason: string): Promise<UpdateRollbackJournal> {
    let journal = await this.require(targetVersion, installRoot);
    if (!samePath(installRoot, journal.installRoot)) throw new Error("Rollback install identity does not match this installation.");
    if (journal.status === "restored") { await this.publishReport(journal); return journal; }
    if (journal.status === "backing-up") {
      return this.finishRestore(journal, reason);
    }
    this.fault("before-restore");
    this.assertBound(journal);
    for (const entry of journal.entries) {
      if (!entry.existed) continue;
      this.assertEntryPaths(journal, entry);
      if (await digest(join(this.backupRoot, entry.path)) !== entry.sha256) throw new Error(`Rollback backup failed integrity verification: ${entry.path}`);
    }
    const restoreComplete = [...(journal.restoreComplete ?? [])];
    for (const entry of [...journal.entries].reverse()) {
      this.assertEntryPaths(journal, entry);
      const target = join(journal.installRoot, entry.path);
      if ((journal.restoreComplete ?? []).includes(entry.path) && await this.entryMatchesRestoredState(target, entry)) continue;
      if (entry.existed) {
        const backup = join(this.backupRoot, entry.path);
        if (await digest(backup) !== entry.sha256) throw new Error(`Rollback backup failed integrity verification: ${entry.path}`);
        await mkdir(dirname(target), { recursive: true });
        this.assertEntryPaths(journal, entry);
        await this.copyNoFollow(backup, target, entry.sha256!, journal, entry);
      } else {
        this.assertEntryPaths(journal, entry);
        await rm(target, { force: true });
      }
      if (!restoreComplete.includes(entry.path)) restoreComplete.push(entry.path);
      this.fault(`after-restore-entry:${entry.path}`);
    }
    return this.finishRestore(journal, reason, restoreComplete);
  }

  async clearRestored(): Promise<void> { await this.clear("restored"); }
  async clearVerified(): Promise<void> { await this.clear("verified"); }
  private async ensureStateRoot(): Promise<void> {
    if (!existsSync(this.stateRoot)) {
      let ancestor = dirname(this.stateRoot);
      while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      directoryIdentity(ancestor);
      await mkdir(this.stateRoot, { recursive: true });
    }
    directoryIdentity(this.stateRoot);
  }
  private assertJournal(journal: UpdateRollbackJournal, expectedInstallRoot = journal.installRoot): void {
    if (!samePath(journal.installRoot, expectedInstallRoot) || !samePath(journal.stateRoot, this.stateRoot)
      || !sameIdentity(journal.installBase, directoryIdentity(journal.installRoot))
      || !sameIdentity(journal.stateBase, directoryIdentity(this.stateRoot))) throw this.ambiguous();
    for (const entry of journal.entries) this.assertEntryPaths(journal, entry);
  }

  private assertRawPath(base: string, path: string, kind: string): void {
    if (!safePathChain(base, path)) throw new Error(`Update rollback ${kind} path became linked or escaped: ${path}`);
  }

  private assertPath(journal: UpdateRollbackJournal, base: string, path: string): void {
    this.assertJournalBases(journal);
    this.assertRawPath(base, path, "transaction");
  }

  private assertEntryPaths(journal: UpdateRollbackJournal, entry: UpdateRollbackEntry): void {
    this.assertJournalBases(journal);
    this.assertRawPath(journal.installRoot, entry.path, "install");
    this.assertRawPath(this.stateRoot, join("update-rollback", "artifacts", entry.path), "backup");
  }

  private assertJournalBases(journal: UpdateRollbackJournal): void {
    if (!sameIdentity(journal.installBase, directoryIdentity(journal.installRoot))
      || !sameIdentity(journal.stateBase, directoryIdentity(this.stateRoot))) throw this.ambiguous();
  }

  private assertBound(journal: UpdateRollbackJournal): void {
    this.assertJournal(journal);
    const anchorPath = join(journal.installRoot, UPDATE_ROLLBACK_ANCHOR);
    this.assertRawPath(journal.installRoot, UPDATE_ROLLBACK_ANCHOR, "anchor");
    let anchor: unknown;
    try { anchor = parseJson(anchorPath); } catch (error) { throw this.ambiguous(error); }
    if (!validAnchor(anchor) || hash(anchor.journal) !== hash(journal)) throw this.ambiguous();
    let onDisk: unknown;
    try { onDisk = parseJson(this.journalPath); } catch (error) { throw this.ambiguous(error); }
    if (!validJournal(onDisk) || hash(onDisk) !== hash(journal)) throw this.ambiguous();
  }

  private async persist(journal: UpdateRollbackJournal, previous: UpdateRollbackJournal | null): Promise<void> {
    if (previous) this.assertBound(previous);
    else if (existsSync(join(journal.installRoot, UPDATE_ROLLBACK_ANCHOR))) throw this.ambiguous();
    this.assertJournal(journal);
    this.assertRawPath(journal.installRoot, UPDATE_ROLLBACK_ANCHOR, "anchor");
    durableJson(join(journal.installRoot, UPDATE_ROLLBACK_ANCHOR), {
      version: UPDATE_ROLLBACK_VERSION, journal, previousCommitment: previous ? hash(previous) : null,
    } satisfies TransactionAnchor);
    this.fault("after-anchor-publication");
    this.assertJournal(journal);
    this.assertRawPath(this.stateRoot, join("update-rollback", "transaction.json"), "journal");
    durableJson(this.journalPath, journal);
    this.fault("after-journal-publication");
    this.assertBound(journal);
  }

  private async transition(previous: UpdateRollbackJournal, next: UpdateRollbackJournal): Promise<void> {
    await this.persist(next, previous);
  }

  private async entryMatchesRestoredState(target: string, entry: UpdateRollbackEntry): Promise<boolean> {
    if (!entry.existed) return !existsSync(target);
    try { return await digest(target) === entry.sha256; } catch { return false; }
  }
  private async copyNoFollow(
    source: string, destination: string, expectedHash: string,
    journal: UpdateRollbackJournal, entry: UpdateRollbackEntry,
  ): Promise<void> {
    const bytes = await readFile(source);
    if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("Rollback source changed during publication.");
    this.assertEntryPaths(journal, entry);
    const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    this.assertEntryPaths(journal, entry);
    if (await digest(destination) !== expectedHash) throw new Error("Rollback publication failed integrity verification.");
  }

  private async finishRestore(
    journal: UpdateRollbackJournal, reason: string, restoreComplete = journal.restoreComplete,
  ): Promise<UpdateRollbackJournal> {
    const restored: UpdateRollbackJournal = {
      ...journal, status: "restored", restoreComplete, restoredAt: new Date().toISOString(), reason,
    };
    await this.transition(journal, restored);
    await this.publishReport(restored);
    this.fault("after-restore");
    return restored;
  }

  private async publishReport(journal: UpdateRollbackJournal): Promise<void> {
    this.assertBound(journal);
    this.assertRawPath(this.stateRoot, "update-rollback-report.json", "report");
    durableJson(join(this.stateRoot, "update-rollback-report.json"), journal);
  }

  private async clear(status: "restored" | "verified"): Promise<void> {
    const journal = await this.read();
    if (!journal || journal.status !== status) return;
    if (status === "restored") await this.publishReport(journal);
    this.assertBound(journal);
    this.assertRawPath(this.stateRoot, "update-rollback", "cleanup");
    await rm(this.directory, { recursive: true, force: true });
    this.assertJournalBases(journal);
    this.assertRawPath(journal.installRoot, UPDATE_ROLLBACK_ANCHOR, "anchor");
    const anchor = parseJson(join(journal.installRoot, UPDATE_ROLLBACK_ANCHOR));
    if (!validAnchor(anchor) || hash(anchor.journal) !== hash(journal)) throw this.ambiguous();
    await rm(join(journal.installRoot, UPDATE_ROLLBACK_ANCHOR), { force: true });
  }

  private async require(targetVersion: string, installRoot?: string): Promise<UpdateRollbackJournal> {
    const journal = await this.read(installRoot);
    if (!journal) throw new Error("Update rollback transaction is missing.");
    if (journal.targetVersion !== targetVersion) throw new Error("Rollback target identity does not match the selected update.");
    return journal;
  }

  private ambiguous(cause?: unknown): Error {
    return new Error("Update rollback journal has ambiguous provenance; refusing to mutate the installation.", { cause });
  }

  /**
   * Discard an orphaned/legacy rollback transaction that cannot be structurally
   * validated and has no anchor witnessing a real, in-flight update. Such a
   * journal carries no trustworthy entries to act on, so there is nothing to
   * preserve — and refusing it (the previous behavior) permanently wedges every
   * future update on the box. Removing it is strictly safer: only the
   * state-root-scoped rollback directory is touched, path-guarded so a crafted
   * journal can never redirect the delete. If the cleanup itself fails, fall back
   * to the conservative refusal rather than claim a clean state.
   */
  private async discardOrphanedJournal(reason: string): Promise<null> {
    try {
      this.assertRawPath(this.stateRoot, "update-rollback", "cleanup");
      await rm(this.directory, { recursive: true, force: true });
    } catch (error) {
      throw this.ambiguous(error);
    }
    console.warn(`[update-rollback] discarded orphaned rollback journal (${reason}); a fresh update can now proceed`);
    return null;
  }
}

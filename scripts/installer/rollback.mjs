import {
  closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, renameSync, rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  loadLegacyCheckpointState, removeLegacyCheckpoint, writeDurableJson,
} from "./checkpoint.mjs";
import {
  defaultStepState, INSTALL_JOURNAL_VERSION, stepStatesEqual, validStepState,
} from "./install-journal.mjs";
import {
  ARTIFACTS, directoryIdentity, ensureDataDirectory, installIdentity, journalProvenance,
  readJson, safePathChain, sameIdentity,
} from "./rollback-provenance.mjs";

const VERSION = INSTALL_JOURNAL_VERSION;

function syncCopiedPath(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) syncCopiedPath(join(path, entry));
  }
  try {
    const handle = openSync(path, info.isDirectory() ? "r" : "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
  } catch (error) {
    if (!info.isDirectory()) throw error;
  }
}

function syncDirectory(path) {
  try {
    const handle = openSync(path, "r");
    try { fsyncSync(handle); } finally { closeSync(handle); }
  } catch {}
}

const supersededStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export function createInstallRollback(context) {
  if (!context.installRoot) {
    return {
      enabled: false,
      reconcile: () => ({ restored: false, outcome: "disabled" }), begin() {},
      rollback: () => ({ restored: false, outcome: "disabled" }), verified() {},
    };
  }
  const root = resolve(context.installRoot || process.cwd());
  const dataDirectory = context.dataDirectory || join(homedir(), ".lax");
  const directory = join(dataDirectory, "install-rollback");
  const journalPath = join(directory, "transaction.json");
  const backupRoot = join(directory, "artifacts");
  const fault = context.installerFault || (() => {});
  const renamePath = context.installerRename || renameSync;
  let boundBases = null;

  const assertBases = () => {
    if (!boundBases) return;
    if (!sameIdentity(boundBases.install, directoryIdentity(root))
      || !sameIdentity(boundBases.data, directoryIdentity(dataDirectory))) {
      throw new Error("Installer rollback trusted base identity changed.");
    }
  };

  const assertPath = (base, relativePath) => {
    assertBases();
    if (!safePathChain(base, relativePath)) {
      throw new Error(`Installer rollback path became linked or escaped: ${relativePath}`);
    }
  };
  const assertJournalPaths = (journal) => {
    assertBases();
    if (journalProvenance(journal, root, dataDirectory, backupRoot) !== "valid") {
      throw new Error("Installer rollback journal paths changed or became unsafe.");
    }
  };
  const removePath = (base, relativePath, options) => {
    assertPath(base, relativePath);
    rmSync(resolve(base, relativePath), options);
  };
  const movePath = (sourceBase, sourceRelative, destinationBase, destinationRelative, afterDestinationDurable) => {
    assertPath(sourceBase, sourceRelative);
    assertPath(destinationBase, destinationRelative);
    const destination = resolve(destinationBase, destinationRelative);
    const parentRelative = relative(destinationBase, dirname(destination));
    if (parentRelative) assertPath(destinationBase, parentRelative);
    mkdirSync(dirname(destination), { recursive: true });
    assertPath(sourceBase, sourceRelative);
    assertPath(destinationBase, destinationRelative);
    const source = resolve(sourceBase, sourceRelative);
    try {
      renamePath(source, destination);
      syncDirectory(dirname(destination));
      syncDirectory(dirname(source));
      afterDestinationDurable?.();
    }
    catch (error) {
      if (error?.code !== "EXDEV") throw error;
      const temporaryRelative = `${destinationRelative}.installer-copy`;
      const temporary = resolve(destinationBase, temporaryRelative);
      assertPath(destinationBase, temporaryRelative);
      rmSync(temporary, { recursive: true, force: true });
      try {
        cpSync(source, temporary, {
          recursive: true, dereference: false, errorOnExist: true, force: false, preserveTimestamps: true,
        });
        syncCopiedPath(temporary);
        assertPath(sourceBase, sourceRelative);
        assertPath(destinationBase, temporaryRelative);
        renameSync(temporary, destination);
        syncDirectory(dirname(destination));
        afterDestinationDurable?.();
        assertPath(sourceBase, sourceRelative);
        assertPath(destinationBase, destinationRelative);
        rmSync(source, { recursive: true, force: true });
        syncDirectory(dirname(source));
      } catch (copyError) {
        assertPath(destinationBase, temporaryRelative);
        rmSync(temporary, { recursive: true, force: true });
        throw copyError;
      }
    }
  };

  // Statuses whose transaction is over: nothing is mid-flight, so the journal
  // is only a record. (active / backing-up / rolling-back are NOT here.)
  const TERMINAL_STATUSES = new Set(["restored", "verified"]);

  // "Holding a backup" means holding BYTES. A completed restore moves the files
  // back and can leave empty directory shells behind; counting those as backups
  // would keep the install bricked for exactly the users this unblocks.
  const survivingBackups = () => {
    try {
      if (!existsSync(backupRoot)) return false;
      return readdirSync(backupRoot, { recursive: true, withFileTypes: true }).some((entry) => entry.isFile());
    } catch { return true; } // unreadable → assume backups exist and stay strict
  };

  /** True when the journal has nothing left to protect: its transaction reached
   *  a terminal status AND no backup artifacts survive on disk. */
  const spentJournal = (value) =>
    Boolean(value) && TERMINAL_STATUSES.has(value.status) && !survivingBackups();

  /** Move a spent journal aside instead of deleting it — the next install
   *  proceeds, and the record survives for diagnosis. */
  const archiveSpentJournal = () => {
    const relativeTarget = join("install-rollback", `transaction.superseded-${supersededStamp()}.json`);
    assertPath(dataDirectory, relativeTarget);
    renamePath(journalPath, resolve(dataDirectory, relativeTarget));
  };

  /** Move the whole rollback directory, journal and backed-up artifacts, to a
   *  sibling. The bases are bound first so every path assertion during the
   *  move also re-proves the data root is the one the journal recorded. */
  const archiveInterruptedAttempt = (journal) => {
    const archived = `install-rollback.superseded-${supersededStamp()}`;
    boundBases = { install: directoryIdentity(root), data: journal.identity.dataBase };
    movePath(dataDirectory, "install-rollback", dataDirectory, archived);
    context.reporter?.warn(
      `The previous install attempt was interrupted and its leftovers were moved to ${join(dataDirectory, archived)}. `
        + "Nothing in that folder is needed; delete it to reclaim the space.",
    );
  };

  const load = () => {
    assertBases();
    directoryIdentity(root);
    if (existsSync(dataDirectory)) directoryIdentity(dataDirectory);
    if (!existsSync(journalPath)) return null;
    const value = readJson(journalPath);
    const provenance = journalProvenance(value, root, dataDirectory, backupRoot);
    if (provenance !== "valid") {
      // A SPENT journal is not ambiguity, it is litter. Terminal status means
      // its transaction already finished (verified) or already rolled back
      // (restored), and an empty/absent artifacts tree means it is holding no
      // backup that could still be restored — so there is nothing left for it
      // to protect. It goes stale the moment a REINSTALL legitimately replaces
      // the install directory: the recorded inode/birthtime stop matching, the
      // provenance check fails, and every future install is blocked forever
      // with no way out. Archive it and carry on.
      if (spentJournal(value)) {
        archiveSpentJournal();
        return null;
      }
      // The standalone installer deletes and re-extracts the install root on
      // every run, so any attempt interrupted mid-transaction leaves a journal
      // that is valid in every respect except that root's identity. Its backups
      // are build output of a source tree that no longer exists and can never
      // be restored into the new one, so blocking protects nothing; moving them
      // aside keeps every byte while this install starts fresh. Every other
      // mismatch (another root path, a replaced data directory, an unsafe or
      // inconsistent artifact set) is still ambiguous and fails closed below.
      if (provenance === "install-replaced") {
        archiveInterruptedAttempt(value);
        return null;
      }
      throw new Error(
        `Installer rollback journal has ambiguous provenance; refusing to mutate installation artifacts. Journal: ${journalPath}`,
      );
    }
    if (readJson(join(root, "package.json"))?.version !== value.identity.version) {
      throw new Error("Installer rollback journal package identity does not match this installation.");
    }
    boundBases = { install: value.identity.installBase, data: value.identity.dataBase };
    context.installerDataRootIdentity = value.identity.dataBase;
    const legacy = loadLegacyCheckpointState(context);
    if (legacy.kind === "corrupt") throw new Error("Legacy installer checkpoint is corrupt or truncated; refusing ambiguous migration.");
    if (value.version === 1) {
      const { version: _legacyVersion, ...legacySteps } = legacy.value || {};
      value.version = VERSION;
      value.steps = legacy.value ? legacySteps : defaultStepState(context);
      save(value);
      removeLegacyCheckpoint(context);
    } else if (legacy.kind === "valid") {
      const { version: _legacyVersion, ...legacySteps } = legacy.value;
      if (!stepStatesEqual(value.steps, legacySteps)) {
        throw new Error("Legacy checkpoint conflicts with the unified installer transaction journal.");
      }
      removeLegacyCheckpoint(context);
    }
    return value;
  };
  const save = (journal) => {
    assertPath(dataDirectory, join("install-rollback", "transaction.json"));
    writeDurableJson(journalPath, journal);
  };
  const restore = (journal, reason) => {
    if (journal.status === "restored") {
      return { restored: true, outcome: "prior-installation-restored" };
    }
    if (journal.status === "verified") {
      removePath(dataDirectory, "install-rollback", { recursive: true, force: true });
      return { restored: false, outcome: "verified-install-retained" };
    }
    if (journal.status === "active" || journal.status === "backing-up") {
      journal.status = "rolling-back";
      journal.reason = reason;
      save(journal);
    }
    fault("before-restore");
    assertJournalPaths(journal);
    for (const item of [...journal.artifacts].reverse()) {
      const target = resolve(root, item.relative);
      const backup = resolve(backupRoot, item.relative);
      if (item.existed) {
        if (item.restored) {
          if (existsSync(backup)) removePath(dataDirectory, join("install-rollback", "artifacts", item.relative), { recursive: true, force: true });
        } else if (existsSync(backup)) {
          assertJournalPaths(journal);
          removePath(root, item.relative, { recursive: true, force: true });
          assertJournalPaths(journal);
          movePath(dataDirectory, join("install-rollback", "artifacts", item.relative), root, item.relative, () => {
            item.restored = true;
            save(journal);
          });
        } else if (!existsSync(target)) throw new Error(`Rollback backup is missing for ${item.relative}.`);
      } else {
        assertJournalPaths(journal);
        removePath(root, item.relative, { recursive: true, force: true });
      }
    }
    const sourcePath = join(dataDirectory, "installed-source.json");
    assertPath(dataDirectory, "installed-source.json");
    if (journal.identity.source) writeDurableJson(sourcePath, journal.identity.source);
    else removePath(dataDirectory, "installed-source.json", { force: true });
    journal.steps.inFlight = null;
    journal.status = "restored";
    journal.restoredAt = new Date().toISOString();
    journal.reason = reason;
    save(journal);
    assertPath(dataDirectory, "install-rollback-report.json");
    writeDurableJson(join(dataDirectory, "install-rollback-report.json"), journal);
    fault("after-restore");
    assertJournalPaths(journal);
    removePath(dataDirectory, join("install-rollback", "artifacts"), { recursive: true, force: true });
    return { restored: true, outcome: "prior-installation-restored" };
  };

  return {
    enabled: true,
    reconcile() {
      const journal = load();
      if (!journal) return { restored: false, resumed: false, outcome: "none" };
      if (journal.status === "active") {
        for (const item of journal.artifacts) {
          if (item.existed && !existsSync(resolve(backupRoot, item.relative))) {
            throw new Error(`Installer rollback backup is missing for ${item.relative}.`);
          }
        }
        return { restored: false, resumed: true, outcome: "installer-transaction-resumed" };
      }
      return { ...restore(journal, "interrupted installer backup"), resumed: false };
    },
    begin(initialSteps = defaultStepState(context)) {
      const prior = load();
      if (prior && prior.status !== "restored") throw new Error("Installer rollback reconciliation must complete before a new transaction.");
      if (!validStepState(initialSteps)) throw new Error("Installer checkpoint state is invalid before backup preparation.");
      if (prior) removePath(dataDirectory, "install-rollback", { recursive: true, force: true });
      const identity = installIdentity(root, dataDirectory);
      const installBase = directoryIdentity(root);
      const dataBase = ensureDataDirectory(dataDirectory);
      boundBases = { install: installBase, data: dataBase };
      context.installerDataRootIdentity = dataBase;
      identity.installBase = installBase;
      identity.dataBase = dataBase;
      if (!ARTIFACTS.every((item) => safePathChain(root, item))) {
        throw new Error("Installer artifact path contains a linked or escaping component.");
      }
      if (!ARTIFACTS.every((item) => safePathChain(dataDirectory, join("install-rollback", "artifacts", item)))) {
        throw new Error("Installer backup path contains a linked or escaping component.");
      }
      const journal = {
        version: VERSION, status: "backing-up", identity, startedAt: new Date().toISOString(),
        steps: initialSteps,
        artifacts: ARTIFACTS.map((item) => ({ relative: item, existed: existsSync(join(root, item)) })),
      };
      assertPath(dataDirectory, join("install-rollback", "artifacts"));
      mkdirSync(backupRoot, { recursive: true });
      save(journal);
      fault("after-backup-journal");
      assertJournalPaths(journal);
      for (const item of journal.artifacts) {
        if (!item.existed) continue;
        const source = join(root, item.relative);
        assertJournalPaths(journal);
        if (lstatSync(source).isSymbolicLink()) throw new Error(`Refusing to back up linked installer artifact ${item.relative}.`);
        movePath(root, item.relative, dataDirectory, join("install-rollback", "artifacts", item.relative));
      }
      journal.status = "active";
      save(journal);
      fault("after-backup");
      assertJournalPaths(journal);
    },
    rollback(reason) {
      const journal = load();
      if (!journal) return { restored: false, outcome: "no-prior-installation" };
      return restore(journal, reason);
    },
    verified() {
      const journal = load();
      if (!journal) throw new Error("Installer rollback transaction is missing at verification.");
      journal.status = "verified";
      journal.verifiedAt = new Date().toISOString();
      save(journal);
      fault("after-verified");
      assertJournalPaths(journal);
      removePath(dataDirectory, "install-rollback", { recursive: true, force: true });
    },
  };
}

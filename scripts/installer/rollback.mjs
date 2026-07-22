import {
  closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
  loadLegacyCheckpointState, removeLegacyCheckpoint, writeDurableJson,
} from "./checkpoint.mjs";
import {
  defaultStepState, INSTALL_JOURNAL_VERSION, stepStatesEqual, validStepState,
} from "./install-journal.mjs";

const VERSION = INSTALL_JOURNAL_VERSION;
const ARTIFACTS = ["node_modules", "dist", join("desktop", "node_modules"), join("desktop", "dist")];

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function directoryIdentity(path) {
  let info;
  try { info = lstatSync(path); }
  catch { throw new Error(`Trusted rollback base is missing: ${path}`); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Trusted rollback base is linked or not a directory: ${path}`);
  let real;
  try { real = realpathSync(path); } catch { throw new Error(`Trusted rollback base cannot be resolved: ${path}`); }
  if (!samePath(real, path)) throw new Error(`Trusted rollback base has a linked ancestor: ${path}`);
  return { path: resolve(path), real: resolve(real), dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

function sameIdentity(expected, actual) {
  return expected && samePath(expected.path, actual.path) && samePath(expected.real, actual.real)
    && expected.dev === actual.dev && expected.ino === actual.ino && expected.birthtimeMs === actual.birthtimeMs;
}

function ensureDataDirectory(path) {
  if (!existsSync(path)) {
    let ancestor = dirname(path);
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    directoryIdentity(ancestor);
    mkdirSync(path, { recursive: true });
  }
  return directoryIdentity(path);
}

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

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

function installIdentity(root, dataDirectory) {
  const manifest = readJson(join(root, "package.json"));
  const source = readJson(join(dataDirectory, "installed-source.json"));
  if (!manifest || typeof manifest.version !== "string") throw new Error("Cannot establish installed package identity.");
  if (source && !/^[0-9a-f]{40}$/.test(source.commit || "")) throw new Error("Installed source identity is corrupt.");
  return { root: resolve(root), version: manifest.version, source };
}

function inside(base, path) {
  const rel = relative(resolve(base), resolve(path));
  return rel !== "" && !isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");
}

function safePathChain(base, relativePath) {
  let current = resolve(base);
  for (const part of relativePath.split(/[\\/]/)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      return false;
    }
    if (info.isSymbolicLink()) return false;
    try { if (!inside(base, realpathSync(current))) return false; }
    catch { return false; }
  }
  return true;
}

function validJournal(value, root, dataDirectory, backupRoot) {
  if (!value || ![1, VERSION].includes(value.version) || !["backing-up", "active", "rolling-back", "verified", "restored"].includes(value.status)) return false;
  if (value.version === VERSION && !validStepState(value.steps)) return false;
  if (resolve(value.identity?.root || "") !== resolve(root)) return false;
  let installBase;
  let dataBase;
  try { installBase = directoryIdentity(root); dataBase = directoryIdentity(dataDirectory); }
  catch { return false; }
  if (!sameIdentity(value.identity.installBase, installBase) || !sameIdentity(value.identity.dataBase, dataBase)) return false;
  if (typeof value.identity.version !== "string") return false;
  if (value.identity.source !== null && !/^[0-9a-f]{40}$/.test(value.identity.source?.commit || "")) return false;
  if (!Array.isArray(value.artifacts)) return false;
  if (value.artifacts.length !== ARTIFACTS.length) return false;
  const expected = [...ARTIFACTS].sort((left, right) => left.localeCompare(right));
  const received = value.artifacts.map((item) => item?.relative).sort((left, right) => String(left).localeCompare(String(right)));
  if (!expected.every((item, index) => item === received[index])) return false;
  if (new Set(received.map((item) => String(item).toLocaleLowerCase("en-US"))).size !== received.length) return false;
  return value.artifacts.every((item) => {
    if (!item || typeof item.relative !== "string" || typeof item.existed !== "boolean") return false;
    if (item.restored !== undefined && typeof item.restored !== "boolean") return false;
    if (item.restored && !["rolling-back", "restored"].includes(value.status)) return false;
    if (!item.relative || item.relative === "." || isAbsolute(item.relative) || normalize(item.relative) !== item.relative) return false;
    if (item.relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) return false;
    const target = resolve(root, item.relative);
    const backup = resolve(backupRoot, item.relative);
    if (!inside(root, target) || !inside(backupRoot, backup)) return false;
    if (!safePathChain(root, item.relative)) return false;
    if (!safePathChain(dataDirectory, join("install-rollback", "artifacts", item.relative))) return false;
    if (item.restored && !existsSync(target)) return false;
    if (item.existed && !existsSync(target) && !existsSync(backup)) return false;
    return item.existed || !existsSync(backup);
  });
}

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
    if (!validJournal(journal, root, dataDirectory, backupRoot)) {
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

  const load = () => {
    assertBases();
    directoryIdentity(root);
    if (existsSync(dataDirectory)) directoryIdentity(dataDirectory);
    if (!existsSync(journalPath)) return null;
    const value = readJson(journalPath);
    if (!validJournal(value, root, dataDirectory, backupRoot)) throw new Error("Installer rollback journal has ambiguous provenance; refusing to mutate installation artifacts.");
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

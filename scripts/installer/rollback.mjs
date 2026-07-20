import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { writeDurableJson } from "./checkpoint.mjs";

const VERSION = 1;
const ARTIFACTS = ["node_modules", "dist", join("desktop", "node_modules"), join("desktop", "dist")];

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

function validJournal(value, root, backupRoot) {
  if (!value || value.version !== VERSION || !["active", "verified", "restored"].includes(value.status)) return false;
  if (resolve(value.identity?.root || "") !== resolve(root)) return false;
  if (typeof value.identity.version !== "string") return false;
  if (value.identity.source !== null && !/^[0-9a-f]{40}$/.test(value.identity.source?.commit || "")) return false;
  if (!Array.isArray(value.artifacts)) return false;
  return value.artifacts.every((item) => {
    if (!item || typeof item.relative !== "string" || typeof item.existed !== "boolean") return false;
    const target = resolve(root, item.relative);
    const backup = resolve(backupRoot, item.relative);
    return relative(resolve(root), target).split(/[\\/]/).every((part) => part !== "..")
      && relative(resolve(backupRoot), backup).split(/[\\/]/).every((part) => part !== "..");
  });
}

function move(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);
}

export function createInstallRollback(context) {
  if (!context.installRoot) {
    return {
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

  const load = () => {
    if (!existsSync(journalPath)) return null;
    const value = readJson(journalPath);
    if (!validJournal(value, root, backupRoot)) throw new Error("Installer rollback journal has ambiguous provenance; refusing to mutate installation artifacts.");
    if (readJson(join(root, "package.json"))?.version !== value.identity.version) {
      throw new Error("Installer rollback journal package identity does not match this installation.");
    }
    return value;
  };
  const save = (journal) => writeDurableJson(journalPath, journal);
  const restore = (journal, reason) => {
    if (journal.status === "restored") {
      rmSync(directory, { recursive: true, force: true });
      return { restored: true, outcome: "prior-installation-restored" };
    }
    if (journal.status === "verified") {
      rmSync(directory, { recursive: true, force: true });
      return { restored: false, outcome: "verified-install-retained" };
    }
    fault("before-restore");
    for (const item of [...journal.artifacts].reverse()) {
      const target = resolve(root, item.relative);
      const backup = resolve(backupRoot, item.relative);
      if (item.existed) {
        if (existsSync(backup)) {
          rmSync(target, { recursive: true, force: true });
          move(backup, target);
        } else if (!existsSync(target)) throw new Error(`Rollback backup is missing for ${item.relative}.`);
      } else rmSync(target, { recursive: true, force: true });
    }
    const sourcePath = join(dataDirectory, "installed-source.json");
    if (journal.identity.source) writeDurableJson(sourcePath, journal.identity.source);
    else rmSync(sourcePath, { force: true });
    journal.status = "restored";
    journal.restoredAt = new Date().toISOString();
    journal.reason = reason;
    save(journal);
    writeDurableJson(join(dataDirectory, "install-rollback-report.json"), journal);
    fault("after-restore");
    rmSync(directory, { recursive: true, force: true });
    return { restored: true, outcome: "prior-installation-restored" };
  };

  return {
    reconcile() {
      const journal = load();
      return journal ? restore(journal, "interrupted installer transaction") : { restored: false, outcome: "none" };
    },
    begin() {
      if (load()) throw new Error("Installer rollback reconciliation must complete before a new transaction.");
      const identity = installIdentity(root, dataDirectory);
      const journal = {
        version: VERSION, status: "active", identity, startedAt: new Date().toISOString(),
        artifacts: ARTIFACTS.map((item) => ({ relative: item, existed: existsSync(join(root, item)) })),
      };
      mkdirSync(backupRoot, { recursive: true });
      save(journal);
      fault("after-backup-journal");
      for (const item of journal.artifacts) {
        if (!item.existed) continue;
        const source = join(root, item.relative);
        if (lstatSync(source).isSymbolicLink()) throw new Error(`Refusing to back up linked installer artifact ${item.relative}.`);
        move(source, join(backupRoot, item.relative));
      }
      fault("after-backup");
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
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

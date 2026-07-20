import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";

const VERSION = 1;
const ANCHOR_FILE = ".lax-update-rollback.json";

interface DirectoryIdentity { path: string; real: string; dev: number; ino: number; birthtimeMs: number }
export interface UpdateRollbackEntry { path: string; existed: boolean; sha256: string | null }
export interface UpdateRollbackJournal {
  version: 1; id: string;
  status: "backing-up" | "active" | "applied" | "verified" | "restored";
  installRoot: string; stateRoot: string;
  installBase: DirectoryIdentity; stateBase: DirectoryIdentity;
  previousVersion: string; targetVersion: string;
  entries: UpdateRollbackEntry[]; manifestCommitment: string; startedAt: string;
  restoredAt?: string; reason?: string;
}

interface TransactionAnchor { version: 1; journal: UpdateRollbackJournal; previousCommitment: string | null }

function durableJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  const file = openSync(temporary, "r+");
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, path);
  try {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { /* Windows cannot fsync directories; the atomic rename still holds. */ }
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

async function digest(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }

function samePath(left: string, right: string): boolean {
  const [a, b] = [resolve(left), resolve(right)];
  return process.platform === "win32" ? a.toLocaleLowerCase("en-US") === b.toLocaleLowerCase("en-US") : a === b;
}

function inside(base: string, path: string): boolean {
  const rel = relative(resolve(base), resolve(path));
  return rel !== "" && !isAbsolute(rel) && !rel.split(/[\\/]/).includes("..");
}

function directoryIdentity(path: string): DirectoryIdentity {
  let info;
  try { info = lstatSync(path); } catch { throw new Error(`Trusted rollback base is missing: ${path}`); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Trusted rollback base is linked or not a directory: ${path}`);
  const real = realpathSync(path);
  if (!samePath(real, path)) throw new Error(`Trusted rollback base has a linked ancestor: ${path}`);
  return { path: resolve(path), real: resolve(real), dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

function sameIdentity(expected: DirectoryIdentity, actual: DirectoryIdentity): boolean {
  return samePath(expected.path, actual.path) && samePath(expected.real, actual.real)
    && expected.dev === actual.dev && expected.ino === actual.ino && expected.birthtimeMs === actual.birthtimeMs;
}

function safeRelative(path: string): boolean {
  return Boolean(path) && path !== "." && !isAbsolute(path) && normalize(path) === path
    && !path.split(/[\\/]/).some((part) => !part || part === "." || part === "..");
}

function safePathChain(base: string, relativePath: string): boolean {
  if (!safeRelative(relativePath) || !inside(base, resolve(base, relativePath))) return false;
  let current = resolve(base);
  for (const part of relativePath.split(/[\\/]/)) {
    current = join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !inside(base, realpathSync(current))) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  return true;
}

function validIdentity(value: unknown): value is DirectoryIdentity {
  const item = value as Partial<DirectoryIdentity> | null;
  return !!item && typeof item.path === "string" && typeof item.real === "string"
    && typeof item.dev === "number" && typeof item.ino === "number" && typeof item.birthtimeMs === "number";
}

function manifest(journal: Omit<UpdateRollbackJournal, "manifestCommitment">): unknown {
  return {
    id: journal.id, installRoot: journal.installRoot, stateRoot: journal.stateRoot,
    installBase: journal.installBase, stateBase: journal.stateBase, previousVersion: journal.previousVersion,
    targetVersion: journal.targetVersion, entries: journal.entries, startedAt: journal.startedAt,
  };
}

function validJournal(value: unknown): value is UpdateRollbackJournal {
  const journal = value as UpdateRollbackJournal | null;
  if (!journal || journal.version !== VERSION || !["backing-up", "active", "applied", "verified", "restored"].includes(journal.status)) return false;
  if (typeof journal.id !== "string" || !journal.id || typeof journal.installRoot !== "string"
    || typeof journal.stateRoot !== "string" || typeof journal.previousVersion !== "string" || !journal.previousVersion
    || typeof journal.targetVersion !== "string" || !journal.targetVersion || typeof journal.startedAt !== "string"
    || !validIdentity(journal.installBase) || !validIdentity(journal.stateBase) || !Array.isArray(journal.entries)) return false;
  if (!journal.entries.every((entry) => entry && safeRelative(entry.path) && typeof entry.existed === "boolean"
    && (entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256)))) return false;
  const folded = journal.entries.map((entry) => entry.path.toLocaleLowerCase("en-US"));
  if (new Set(folded).size !== folded.length) return false;
  if (!journal.entries.every((entry, index) => !index
    || journal.entries[index - 1]!.path.localeCompare(entry.path) <= 0)) return false;
  const { manifestCommitment: _commitment, ...unsigned } = journal;
  return /^[0-9a-f]{64}$/.test(journal.manifestCommitment) && hash(manifest(unsigned)) === journal.manifestCommitment;
}

function validAnchor(value: unknown): value is TransactionAnchor {
  const anchor = value as TransactionAnchor | null;
  return !!anchor && anchor.version === VERSION && validJournal(anchor.journal)
    && (anchor.previousCommitment === null || /^[0-9a-f]{64}$/.test(anchor.previousCommitment));
}
function parseJson(path: string): unknown {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(descriptor, "utf-8")); }
  finally { closeSync(descriptor); }
}

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
      throw this.ambiguous();
    }
    const anchorPath = join(installRoot, ANCHOR_FILE);
    let anchor: unknown;
    try { anchor = parseJson(anchorPath); }
    catch (error) {
      if (!journalPresent && !existsSync(anchorPath)) return null;
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
      if (!safeRelative(path) || path.toLocaleLowerCase("en-US") === ANCHOR_FILE.toLocaleLowerCase("en-US")) throw new Error(`Unsafe update path '${path}'.`);
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
    const unsigned = {
      version: VERSION as 1, id: randomUUID(), status: "backing-up" as const, installRoot: root,
      stateRoot: resolve(this.stateRoot), installBase, stateBase, previousVersion, targetVersion, entries,
      startedAt: new Date().toISOString(),
    };
    const journal: UpdateRollbackJournal = { ...unsigned, manifestCommitment: hash(manifest(unsigned as Omit<UpdateRollbackJournal, "manifestCommitment">)) };
    this.assertRawPath(this.stateRoot, join("update-rollback", "artifacts"), "backup");
    await mkdir(this.backupRoot, { recursive: true });
    await this.persist(journal, null);
    this.fault("after-backup-journal");
    for (const entry of entries) {
      if (!entry.existed) continue;
      this.assertBound(journal);
      this.assertEntryPaths(journal, entry);
      await mkdir(dirname(join(this.backupRoot, entry.path)), { recursive: true });
      this.assertBound(journal);
      this.assertEntryPaths(journal, entry);
      await this.copyNoFollow(join(root, entry.path), join(this.backupRoot, entry.path), entry.sha256!, journal, entry);
      this.fault(`after-backup-entry:${entry.path}`);
    }
    await this.transition(journal, { ...journal, status: "active" });
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
    const journal = await this.require(targetVersion, installRoot);
    if (!samePath(installRoot, journal.installRoot)) throw new Error("Rollback install identity does not match this installation.");
    if (journal.status === "restored") { await this.publishReport(journal); return journal; }
    if (journal.status === "backing-up") {
      for (const entry of journal.entries) {
        this.assertBound(journal);
        this.assertEntryPaths(journal, entry);
        const target = join(journal.installRoot, entry.path);
        if (entry.existed) {
          try { if (await digest(target) !== entry.sha256) throw new Error(); }
          catch { throw new Error(`Interrupted backup left ambiguous source state: ${entry.path}`); }
        } else if (existsSync(target)) throw new Error(`Interrupted backup created unexpected artifact: ${entry.path}`);
      }
      return this.finishRestore(journal, reason);
    }
    this.fault("before-restore");
    for (const entry of journal.entries) {
      if (!entry.existed) continue;
      this.assertBound(journal);
      this.assertEntryPaths(journal, entry);
      if (await digest(join(this.backupRoot, entry.path)) !== entry.sha256) throw new Error(`Rollback backup failed integrity verification: ${entry.path}`);
    }
    for (const entry of [...journal.entries].reverse()) {
      this.assertBound(journal);
      this.assertEntryPaths(journal, entry);
      const target = join(journal.installRoot, entry.path);
      if (entry.existed) {
        const backup = join(this.backupRoot, entry.path);
        if (await digest(backup) !== entry.sha256) throw new Error(`Rollback backup failed integrity verification: ${entry.path}`);
        await mkdir(dirname(target), { recursive: true });
        this.assertBound(journal);
        this.assertEntryPaths(journal, entry);
        await this.copyNoFollow(backup, target, entry.sha256!, journal, entry);
      } else {
        this.assertBound(journal);
        this.assertEntryPaths(journal, entry);
        await rm(target, { force: true });
      }
      this.fault(`after-restore-entry:${entry.path}`);
    }
    return this.finishRestore(journal, reason);
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
    const anchorPath = join(journal.installRoot, ANCHOR_FILE);
    this.assertRawPath(journal.installRoot, ANCHOR_FILE, "anchor");
    let anchor: unknown;
    try { anchor = parseJson(anchorPath); } catch (error) { throw this.ambiguous(error); }
    if (!validAnchor(anchor) || hash(anchor.journal) !== hash(journal)) throw this.ambiguous();
    let onDisk: unknown;
    try { onDisk = parseJson(this.journalPath); } catch (error) { throw this.ambiguous(error); }
    if (!validJournal(onDisk) || hash(onDisk) !== hash(journal)) throw this.ambiguous();
  }

  private async persist(journal: UpdateRollbackJournal, previous: UpdateRollbackJournal | null): Promise<void> {
    if (previous) this.assertBound(previous);
    else if (existsSync(join(journal.installRoot, ANCHOR_FILE))) throw this.ambiguous();
    this.assertJournal(journal);
    this.assertRawPath(journal.installRoot, ANCHOR_FILE, "anchor");
    durableJson(join(journal.installRoot, ANCHOR_FILE), {
      version: VERSION, journal, previousCommitment: previous ? hash(previous) : null,
    } satisfies TransactionAnchor);
    this.assertJournal(journal);
    this.assertRawPath(this.stateRoot, join("update-rollback", "transaction.json"), "journal");
    durableJson(this.journalPath, journal);
    this.assertBound(journal);
  }

  private async transition(previous: UpdateRollbackJournal, next: UpdateRollbackJournal): Promise<void> {
    await this.persist(next, previous);
  }
  private async copyNoFollow(
    source: string, destination: string, expectedHash: string,
    journal: UpdateRollbackJournal, entry: UpdateRollbackEntry,
  ): Promise<void> {
    const bytes = await readFile(source);
    if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("Rollback source changed during publication.");
    this.assertBound(journal);
    this.assertEntryPaths(journal, entry);
    const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    this.assertBound(journal);
    this.assertEntryPaths(journal, entry);
    if (await digest(destination) !== expectedHash) throw new Error("Rollback publication failed integrity verification.");
  }

  private async finishRestore(journal: UpdateRollbackJournal, reason: string): Promise<UpdateRollbackJournal> {
    const restored: UpdateRollbackJournal = {
      ...journal, status: "restored", restoredAt: new Date().toISOString(), reason,
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
    this.assertRawPath(journal.installRoot, ANCHOR_FILE, "anchor");
    const anchor = parseJson(join(journal.installRoot, ANCHOR_FILE));
    if (!validAnchor(anchor) || hash(anchor.journal) !== hash(journal)) throw this.ambiguous();
    await rm(join(journal.installRoot, ANCHOR_FILE), { force: true });
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
}

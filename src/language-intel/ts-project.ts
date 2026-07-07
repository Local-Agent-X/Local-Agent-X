// Per-project TypeScript LanguageService management for language-intel.
//
// One in-process ts.LanguageService per project root — the nearest
// tsconfig.json above the queried file, or a default NodeNext-ish config over
// the containing directory when none exists. No tsserver child process: the
// `typescript` package is already a dependency and the LanguageService API is
// the same engine tsserver wraps.
//
// Freshness model: the host reads files lazily from disk and records the fs
// mtime alongside each snapshot. refresh() (called by the provider before
// every query) re-stats snapshotted files and bumps the version of anything
// that changed, so an edit made after service creation is answered over
// current content. invalidate() force-bumps a single file for callers that
// know they just wrote it.
//
// Lifecycle: at most MAX_PROJECTS live services (LRU-evicted); a service
// untouched for IDLE_DISPOSE_MS is disposed by an unref()d timer so a parked
// project never holds memory or keeps the process open.

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const MAX_PROJECTS = 4;
const IDLE_DISPOSE_MS = 5 * 60_000;

/** Extensions the TS service hosts. Mirrors ts-provider's supports(). */
const SCRIPT_EXT_RE = /\.(ts|tsx|js|jsx|mts|cts)$/i;

/** Compiler options used when no tsconfig.json governs the file. */
const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  allowJs: true,
  esModuleInterop: true,
  skipLibCheck: true,
};

interface FileEntry {
  version: number;
  snapshot: ts.IScriptSnapshot | null;
  /** fs mtimeMs at snapshot time; compared by refresh() to detect edits.
   *  -1 = the file was unreadable when we last looked. */
  mtimeMs: number;
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1; // deleted/unreadable — differs from any real mtime, so refresh() invalidates
  }
}

export class TsProject {
  readonly root: string;
  readonly service: ts.LanguageService;
  private readonly options: ts.CompilerOptions;
  private readonly fileNames: Set<string>;
  private readonly files = new Map<string, FileEntry>();
  private projectVersion = 0;

  constructor(root: string, options: ts.CompilerOptions, fileNames: string[]) {
    this.root = root;
    this.options = options;
    this.fileNames = new Set(fileNames.map((f) => resolve(f)));
    this.service = ts.createLanguageService(this.createHost(), ts.createDocumentRegistry());
  }

  private createHost(): ts.LanguageServiceHost {
    return {
      getCompilationSettings: () => this.options,
      getProjectVersion: () => String(this.projectVersion),
      getScriptFileNames: () => [...this.fileNames],
      getScriptVersion: (file) => String(this.files.get(resolve(file))?.version ?? 1),
      getScriptSnapshot: (file) => this.snapshotFor(resolve(file)) ?? undefined,
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
  }

  private snapshotFor(file: string): ts.IScriptSnapshot | null {
    let entry = this.files.get(file);
    if (entry === undefined) {
      entry = { version: 1, snapshot: null, mtimeMs: -1 };
      this.files.set(file, entry);
    }
    if (entry.snapshot !== null) return entry.snapshot;
    const text = ts.sys.readFile(file);
    if (text === undefined) return null;
    entry.snapshot = ts.ScriptSnapshot.fromString(text);
    entry.mtimeMs = mtimeOf(file);
    return entry.snapshot;
  }

  /** Add a file to the project's root set so queries against it resolve even
   *  when the governing tsconfig excludes it. Returns false when the file is
   *  unsupported or missing (caller answers with empty results, not a throw). */
  ensureFile(file: string): boolean {
    const abs = resolve(file);
    if (this.fileNames.has(abs)) return true;
    if (!SCRIPT_EXT_RE.test(abs) || !existsSync(abs)) return false;
    this.fileNames.add(abs);
    this.projectVersion++;
    return true;
  }

  /** Force a single file to be re-read from disk on the next query. */
  invalidate(file: string): void {
    const entry = this.files.get(resolve(file));
    if (entry !== undefined && entry.snapshot !== null) {
      entry.version++;
      entry.snapshot = null;
      this.projectVersion++;
    }
  }

  /** mtime-based staleness sweep: drop any snapshot whose file changed on
   *  disk since we read it, so the next query answers over current content. */
  refresh(): void {
    for (const [file, entry] of this.files) {
      if (entry.snapshot === null) continue;
      if (mtimeOf(file) !== entry.mtimeMs) {
        entry.version++;
        entry.snapshot = null;
        this.projectVersion++;
      }
    }
  }

  dispose(): void {
    this.service.dispose();
    this.files.clear();
  }
}

// ── project registry (LRU cap + idle disposal) ──

interface ProjectSlot {
  project: TsProject;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
}

const projects = new Map<string, ProjectSlot>();

/** Walk up from `dir` to the nearest tsconfig.json, or null when none. */
function findTsconfig(dir: string): string | null {
  let cur = resolve(dir);
  for (;;) {
    const candidate = join(cur, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function createProject(configPath: string | null, fallbackDir: string): TsProject {
  if (configPath === null) return new TsProject(resolve(fallbackDir), DEFAULT_OPTIONS, []);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const rootDir = dirname(configPath);
  // A malformed tsconfig degrades to the default options over its directory —
  // queries still answer; they just lose the project's custom settings.
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, rootDir);
  return new TsProject(rootDir, parsed.options, parsed.fileNames);
}

function acquire(configPath: string | null, fallbackDir: string): TsProject {
  const key = configPath !== null ? dirname(resolve(configPath)) : resolve(fallbackDir);
  let slot = projects.get(key);
  if (slot === undefined) {
    evictOverCap();
    slot = { project: createProject(configPath, fallbackDir), lastUsed: 0, idleTimer: null };
    projects.set(key, slot);
  }
  touch(key, slot);
  return slot.project;
}

function touch(key: string, slot: ProjectSlot): void {
  slot.lastUsed = Date.now();
  if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => disposeProject(key), IDLE_DISPOSE_MS);
  // Never let a parked LanguageService hold the process open.
  slot.idleTimer.unref();
}

function evictOverCap(): void {
  while (projects.size >= MAX_PROJECTS) {
    let lruKey: string | null = null;
    let lruUsed = Infinity;
    for (const [key, slot] of projects) {
      if (slot.lastUsed < lruUsed) {
        lruUsed = slot.lastUsed;
        lruKey = key;
      }
    }
    if (lruKey === null) return;
    disposeProject(lruKey);
  }
}

function disposeProject(key: string): void {
  const slot = projects.get(key);
  if (slot === undefined) return;
  if (slot.idleTimer !== null) clearTimeout(slot.idleTimer);
  slot.project.dispose();
  projects.delete(key);
}

/** The (cached) service governing `file` — nearest tsconfig, else default
 *  config over the file's directory. */
export function getProjectForFile(file: string): TsProject {
  const dir = dirname(resolve(file));
  return acquire(findTsconfig(dir), dir);
}

/** Dispose every live service. For tests and process shutdown. */
export function disposeAllProjects(): void {
  for (const key of [...projects.keys()]) disposeProject(key);
}

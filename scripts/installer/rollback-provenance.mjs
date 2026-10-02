import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { INSTALL_JOURNAL_VERSION, validStepState } from "./install-journal.mjs";

export const ARTIFACTS = ["node_modules", "dist", join("desktop", "node_modules"), join("desktop", "dist")];
const STATUSES = ["backing-up", "active", "rolling-back", "verified", "restored"];

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

export function directoryIdentity(path) {
  let info;
  try { info = lstatSync(path); }
  catch { throw new Error(`Trusted rollback base is missing: ${path}`); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Trusted rollback base is linked or not a directory: ${path}`);
  let real;
  try { real = realpathSync(path); } catch { throw new Error(`Trusted rollback base cannot be resolved: ${path}`); }
  if (!samePath(real, path)) throw new Error(`Trusted rollback base has a linked ancestor: ${path}`);
  return { path: resolve(path), real: resolve(real), dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

export function sameIdentity(expected, actual) {
  return expected && samePath(expected.path, actual.path) && samePath(expected.real, actual.real)
    && expected.dev === actual.dev && expected.ino === actual.ino && expected.birthtimeMs === actual.birthtimeMs;
}

// Same location, different directory: what deleting and re-extracting the
// install root produces. A base recorded at any other path is not this.
// A record missing its numeric identity is corrupt, not replaced, and stays
// fail-closed.
function replacedIdentity(expected, actual) {
  return typeof expected?.path === "string" && typeof expected.real === "string"
    && [expected.dev, expected.ino, expected.birthtimeMs].every(Number.isFinite)
    && samePath(expected.path, actual.path) && samePath(expected.real, actual.real)
    && !sameIdentity(expected, actual);
}

export function ensureDataDirectory(path) {
  if (!existsSync(path)) {
    let ancestor = dirname(path);
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    directoryIdentity(ancestor);
    mkdirSync(path, { recursive: true });
  }
  return directoryIdentity(path);
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

export function installIdentity(root, dataDirectory) {
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

export function safePathChain(base, relativePath) {
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

function validArtifactSet(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length !== ARTIFACTS.length) return false;
  const expected = [...ARTIFACTS].sort((left, right) => left.localeCompare(right));
  const received = artifacts.map((item) => item?.relative).sort((left, right) => String(left).localeCompare(String(right)));
  if (!expected.every((item, index) => item === received[index])) return false;
  return new Set(received.map((item) => String(item).toLocaleLowerCase("en-US"))).size === received.length;
}

// Once the install root has been replaced, what the journal says sits in that
// tree describes a tree that no longer exists, so only its path safety and its
// claims about the backup tree (still the same directory) are checked.
function validArtifact(item, status, root, dataDirectory, backupRoot, installTreeKnown) {
  if (!item || typeof item.relative !== "string" || typeof item.existed !== "boolean") return false;
  if (item.restored !== undefined && typeof item.restored !== "boolean") return false;
  if (item.restored && !["rolling-back", "restored"].includes(status)) return false;
  if (!item.relative || item.relative === "." || isAbsolute(item.relative) || normalize(item.relative) !== item.relative) return false;
  if (item.relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) return false;
  const target = resolve(root, item.relative);
  const backup = resolve(backupRoot, item.relative);
  if (!inside(root, target) || !inside(backupRoot, backup)) return false;
  if (!safePathChain(root, item.relative)) return false;
  if (!safePathChain(dataDirectory, join("install-rollback", "artifacts", item.relative))) return false;
  if (!item.existed && existsSync(backup)) return false;
  if (!installTreeKnown) return true;
  if (item.restored && !existsSync(target)) return false;
  return !item.existed || existsSync(target) || existsSync(backup);
}

/** "valid" when the journal describes this exact installation; "install-replaced"
 *  when it would be valid except that the install root at the recorded path is
 *  now a different directory; "invalid" for anything else. */
export function journalProvenance(value, root, dataDirectory, backupRoot) {
  if (!value || ![1, INSTALL_JOURNAL_VERSION].includes(value.version) || !STATUSES.includes(value.status)) return "invalid";
  if (value.version === INSTALL_JOURNAL_VERSION && !validStepState(value.steps)) return "invalid";
  if (typeof value.identity?.root !== "string" || !samePath(value.identity.root, root)) return "invalid";
  let installBase;
  let dataBase;
  try { installBase = directoryIdentity(root); dataBase = directoryIdentity(dataDirectory); }
  catch { return "invalid"; }
  if (!sameIdentity(value.identity.dataBase, dataBase)) return "invalid";
  const installTreeKnown = Boolean(sameIdentity(value.identity.installBase, installBase));
  if (!installTreeKnown && !replacedIdentity(value.identity.installBase, installBase)) return "invalid";
  if (typeof value.identity.version !== "string") return "invalid";
  if (value.identity.source !== null && !/^[0-9a-f]{40}$/.test(value.identity.source?.commit || "")) return "invalid";
  if (!validArtifactSet(value.artifacts)) return "invalid";
  const artifactsHold = value.artifacts.every((item) =>
    validArtifact(item, value.status, root, dataDirectory, backupRoot, installTreeKnown));
  if (!artifactsHold) return "invalid";
  return installTreeKnown ? "valid" : "install-replaced";
}

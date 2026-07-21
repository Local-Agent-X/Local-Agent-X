import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function identity(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Installer data root is linked or not a directory: ${path}`);
  const real = realpathSync(path);
  if (!samePath(real, path)) throw new Error(`Installer data root has a linked ancestor: ${path}`);
  return { path: resolve(path), real: resolve(real), dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

function sameIdentity(left, right) {
  return left && right && samePath(left.path, right.path) && samePath(left.real, right.real)
    && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function ensureDirectory(path) {
  if (!existsSync(path)) {
    let ancestor = dirname(path);
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    identity(ancestor);
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return identity(path);
}

function safeChild(root, relativePath) {
  const target = resolve(root, relativePath);
  const rel = relative(resolve(root), target);
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return false;
  let current = resolve(root);
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    const info = lstatSync(current);
    if (info.isSymbolicLink()) return false;
    if (info.isFile() && info.nlink !== 1) return false;
    if (!samePath(realpathSync(current), current)) return false;
  }
  return true;
}

export function bindInstallerDataRoot(context) {
  const current = ensureDirectory(context.dataDirectory);
  if (context.installerDataRootIdentity && !sameIdentity(context.installerDataRootIdentity, current)) {
    throw new Error("Installer trusted base identity changed or became linked.");
  }
  context.installerDataRootIdentity = current;
  return current;
}

export function assertInstallerDataRoot(context, relativePaths = []) {
  const current = identity(context.dataDirectory);
  if (!sameIdentity(context.installerDataRootIdentity, current)) throw new Error("Installer trusted base identity changed or became linked.");
  if (!relativePaths.every((path) => safeChild(context.dataDirectory, path))) {
    throw new Error("Installer data-root path became linked or escaped.");
  }
  return current;
}

export function mutateInstallerDataRoot(context, relativePaths, mutation) {
  assertInstallerDataRoot(context, relativePaths);
  context.installerDataRootFault?.("after-validation", relativePaths);
  assertInstallerDataRoot(context, relativePaths);
  const result = mutation();
  assertInstallerDataRoot(context, relativePaths);
  return result;
}

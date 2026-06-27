// Single source of truth for the pinned PortableGit release used to provision a
// POSIX shell (Git Bash + MSYS2 coreutils) on Windows. Imported by
// scripts/install-common.mjs (provisionPortableGit). The runtime resolver
// src/tools/shell-env.ts portableGitBashPath() keeps its own copy of the extract
// path because it runs in a different process/build and can't import this
// install-only script — those two are a documented load-bearing coupling.
//
// The release TAG is v{VERSION}.windows.1 but the asset/version string is just
// {VERSION}. git-for-windows publishes no SHASUMS file, so the pinned SHA256 is
// the source of truth — the caller verifies the download against it fail-closed.
import { join } from "node:path";

export const GIT_PORTABLE_VERSION = "2.54.0";
export const GIT_PORTABLE_SHA256 = "bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311";

export function portableGitAssetName(version = GIT_PORTABLE_VERSION) {
  return `PortableGit-${version}-64-bit.7z.exe`;
}

export function portableGitDownloadUrl(version = GIT_PORTABLE_VERSION) {
  return `https://github.com/git-for-windows/git/releases/download/v${version}.windows.1/${portableGitAssetName(version)}`;
}

// The SFX extracts to <its-own-dir>\PortableGit (it ignores any output flag), so
// this is also the parent dir the downloaded .exe must sit in. The leaf MUST
// stay "PortableGit" (baked into the SFX) and byte-match
// src/tools/shell-env.ts portableGitBashPath.
export function portableGitExtractDir(localAppData) {
  return join(localAppData, "LocalAgentX", "PortableGit");
}

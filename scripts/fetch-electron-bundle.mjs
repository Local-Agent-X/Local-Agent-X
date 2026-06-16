// Download the official Electron runtime archive for ONE platform/arch and drop
// it into installer/electron-bundle/ so the installer build embeds it (see
// installer/Installer.csproj). At install time SourceDownloader writes it into
// <installDir>/vendor/electron/ and install-common.mjs extracts it offline —
// eliminating the postinstall CDN download that was the #1 install failure
// (proxy/region CDN blocks, antivirus quarantine).
//
// Usage (run from the repo root, e.g. in CI before `dotnet publish`):
//   node scripts/fetch-electron-bundle.mjs --platform win32 --arch x64
//   node scripts/fetch-electron-bundle.mjs --platform darwin --arch arm64
//
// Defaults to the host platform/arch. The version is the EXACT one pinned in
// desktop/package-lock.json, so the bundled runtime always matches the JS shim
// that npm installs at install time. Verifies the download against the release's
// SHASUMS256.txt before writing — a corrupted/MITM'd archive fails the build
// rather than shipping a broken installer.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function resolveElectronVersion() {
  // Exact pin from the lockfile is the source of truth (matches what `npm ci`
  // installs in desktop/). Fall back to the package.json range with the caret
  // stripped only if the lockfile is somehow absent.
  const lockPath = join(repoRoot, "desktop", "package-lock.json");
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
      const v = lock.packages?.["node_modules/electron"]?.version;
      if (v) return v;
    } catch { /* fall through */ }
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, "desktop", "package.json"), "utf-8"));
  const range = pkg.dependencies?.electron || pkg.devDependencies?.electron || "";
  const v = range.replace(/^[^0-9]*/, "");
  if (!v) throw new Error("Could not resolve the Electron version from desktop/package-lock.json or package.json");
  return v;
}

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": "LocalAgentX-bundle-fetch/1.0" } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const platform = arg("platform", process.platform);
const arch = arg("arch", process.arch);
const version = resolveElectronVersion();
const fileName = `electron-v${version}-${platform}-${arch}.zip`;
const base = `https://github.com/electron/electron/releases/download/v${version}`;

const outDir = join(repoRoot, "installer", "electron-bundle");
// Start clean so a version bump never leaves a stale archive that the installer
// would embed alongside (or instead of) the current one.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`[electron-bundle] fetching ${fileName} …`);
const [zip, shasums] = await Promise.all([
  download(`${base}/${fileName}`),
  download(`${base}/SHASUMS256.txt`),
]);

// Verify integrity against the release's published checksum.
const expected = shasums
  .toString("utf-8")
  .split("\n")
  .map((l) => l.trim().split(/\s+/))
  .find(([, name]) => name === `*${fileName}` || name === fileName)?.[0];
if (!expected) throw new Error(`No SHASUMS256 entry for ${fileName}`);
const actual = createHash("sha256").update(zip).digest("hex");
if (actual !== expected) {
  throw new Error(`Checksum mismatch for ${fileName}\n  expected ${expected}\n  actual   ${actual}`);
}

const dest = join(outDir, fileName);
writeFileSync(dest, zip);
console.log(`[electron-bundle] verified + wrote ${dest} (${(zip.length / 1024 / 1024).toFixed(1)} MB)`);

// App-owned Node runtime (macOS).
//
// The server must run on a Node binary whose code identity is STABLE across
// system changes, because macOS keys TCC grants (Documents, Screen Recording,
// Accessibility) to the identity of the process performing the operation. The
// server historically ran on Homebrew's `node` — ad-hoc signed, so the grant
// pins to its exact code hash; a `brew upgrade node` swaps the binary and
// silently revokes the grant (workspace apps stop listing with EPERM, screen
// capture / remote control go dead). Windows already dodges this with a pinned
// portable node (installer NodeBootstrap.InstallNodeFromZip); this is the
// macOS counterpart.
//
// We provision the OFFICIAL nodejs.org darwin build into ~/.lax/runtime. Unlike
// brew's, it links nothing outside /usr/lib + /System (survives any brew
// change) and is signed by the Node.js Foundation (Team HX7739G8FX, hardened
// runtime) — so the grant keys to that stable Developer ID and survives even
// our own future node updates. server-process.ts prepends ~/.lax/runtime/bin to
// PATH, so the spawn resolves this node ahead of brew's.
//
// Self-heal is non-blocking: a present runtime is a single stat; an absent one
// kicks off a background download and this boot falls back to PATH node (one
// extra boot before cutover — never a blocked or bricked launch).

import { existsSync, mkdirSync, rmSync, renameSync, readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";

// Keep in lockstep with installer NodeBootstrap.cs NODE_FALLBACK_VERSION and
// install.sh — the runtime, the GUI installer, and the CLI installer must
// provision the SAME Node so native addons (better-sqlite3) share one ABI.
const MANAGED_NODE_VERSION = "24.16.0";

export const MANAGED_NODE_DIR = join(homedir(), ".lax", "runtime");
export const MANAGED_NODE_BIN = join(MANAGED_NODE_DIR, "bin", "node");
const VERSION_SENTINEL = join(MANAGED_NODE_DIR, ".node-version");

let provisioning = false;

function nodeArch(): "arm64" | "x64" {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function installedVersion(): string | null {
  try { return readFileSync(VERSION_SENTINEL, "utf-8").trim(); } catch { return null; }
}

/** The app-owned node when present (any working copy is fine to spawn this
 *  boot), else null. Triggers a one-shot background provision whenever the
 *  binary is missing or behind the pinned version. macOS only — Windows ships
 *  its own portable node, Linux uses the distro package. Never blocks. */
export function ensureManagedNode(): string | null {
  if (process.platform !== "darwin") return null;
  const present = existsSync(MANAGED_NODE_BIN);
  if (!present || installedVersion() !== MANAGED_NODE_VERSION) void provision();
  return present ? MANAGED_NODE_BIN : null;
}

async function provision(): Promise<void> {
  if (provisioning) return;
  provisioning = true;
  const pkg = `node-v${MANAGED_NODE_VERSION}-darwin-${nodeArch()}`;
  const base = `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}`;
  const staging = `${MANAGED_NODE_DIR}.new`;
  const tgz = join(homedir(), ".lax", `${pkg}.tar.gz`);
  try {
    mkdirSync(join(homedir(), ".lax"), { recursive: true });
    console.log(`[desktop] provisioning app-owned Node ${MANAGED_NODE_VERSION} (${pkg})…`);
    await download(`${base}/${pkg}.tar.gz`, tgz);
    await verifyChecksum(tgz, `${pkg}.tar.gz`, `${base}/SHASUMS256.txt`);

    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    await untar(tgz, staging); // --strip-components=1 ⇒ bin/node directly under staging

    // Swap atomically-ish: two renames keep the live dir absent only for the
    // microseconds between them (background self-heal — PATH falls through to
    // brew meanwhile, so a brief gap is harmless).
    const old = `${MANAGED_NODE_DIR}.old`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(MANAGED_NODE_DIR)) renameSync(MANAGED_NODE_DIR, old);
    renameSync(staging, MANAGED_NODE_DIR);
    rmSync(old, { recursive: true, force: true });
    writeFileSync(VERSION_SENTINEL, MANAGED_NODE_VERSION);
    console.log(`[desktop] app-owned Node ready at ${MANAGED_NODE_BIN}`);
  } catch (e) {
    console.error("[desktop] managed-node provision failed (falling back to PATH node):", e);
    rmSync(staging, { recursive: true, force: true });
  } finally {
    rmSync(tgz, { force: true });
    provisioning = false;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} → HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Fail closed on a checksum mismatch; degrade to HTTPS-trust (a warning) only
 *  when the SHASUMS file itself can't be fetched — matching the install-time
 *  bar, but stricter when the data is available. */
async function verifyChecksum(file: string, name: string, sumsUrl: string): Promise<void> {
  let sums: string;
  try {
    const res = await fetch(sumsUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sums = await res.text();
  } catch (e) {
    console.warn(`[desktop] could not fetch ${sumsUrl} (${e}) — proceeding on HTTPS trust`);
    return;
  }
  const want = sums.split("\n").find((l) => l.trim().endsWith(name))?.trim().split(/\s+/)[0];
  if (!want) { console.warn(`[desktop] no checksum line for ${name} — proceeding on HTTPS trust`); return; }
  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (got !== want) throw new Error(`checksum mismatch for ${name}: got ${got}, want ${want}`);
}

function untar(tgz: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("/usr/bin/tar", ["-xzf", tgz, "-C", destDir, "--strip-components=1"], { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
}

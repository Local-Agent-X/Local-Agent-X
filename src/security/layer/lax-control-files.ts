/**
 * Classification of the app's OWN special files under a `.lax` data dir.
 *
 * Three kinds live here because they answer the same question — "is this path
 * one of Local Agent X's own files, as opposed to the user's content?":
 *
 *   isAppAtRestSecretUnderLax — at-rest key/seed material. Blocked for READ
 *                               and write; it is credential material.
 *   isLaxControlFile          — the security switches. READABLE, but never
 *                               writable; they define what the agent may do.
 *   laxApprovalGatedFile      — everything else the app keeps there and reads
 *                               back. Writable only with the user's yes
 *                               (tool-execution/control-file-gate.ts), except
 *                               the agent's own working data.
 *
 * The first two are enforced by the file-access gate (file-access.ts). Which
 * location is which is the one table in lax-data-catalog.ts.
 *
 * ── The security switches ──
 *
 * NOT secrets, and deliberately still READABLE: knowing your own configuration
 * is benign, and the agent legitimately reads settings to resolve its provider,
 * model, and workspace. WRITING one is privilege escalation, because these
 * files ARE the user's leash: the protected settings and their runtime mirror,
 * the tool rule table, egress and its allowlist, the autonomy profile, the
 * consent to an unconfined shell, the server cage's boot marker (two failed
 * attempts and the next boot runs uncaged), the API tokens and their roles,
 * the exfil patterns the user approved once, the missions with the autonomy
 * profile each runs under unattended, and the repository sync pushes memory
 * and chats to.
 *
 * Every INTENDED mutation path is gated: the `setting` tool requires explicit
 * user approval (tool-execution/protected-setting-gate.ts), POST /api/settings
 * requires a real operator token (routes/settings/preferences.ts), the agent
 * RBAC role is denied /api/security, /api/tool-policy and /api/sync
 * (rbac-agent-denials.ts), and the mission tools refuse to grant a profile
 * (cron/job-authority.ts). A raw file write walks past all of them at once,
 * which is what makes this block load-bearing rather than redundant with them.
 * The app writes these files itself (egress-policy-state.ts, profile-store.ts,
 * sandbox/index.ts, server-confine.ts, rbac.ts, trust-ledger.ts,
 * cron-service.ts, sync/index.ts) without the file tools. A sync pull writes
 * none of them but the missions, and a pulled mission keeps only the profile
 * this computer granted it (sync/pull-files/pull-misc.ts), so the block costs
 * no legitimate path.
 *
 * Enforced in file-access.ts ABOVE the mode branches, so "unrestricted" file
 * access does not mean "may rewrite my own permissions".
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isAppAtRestSecretBasename } from "../secrets/known-secrets.js";
import { LAX_DATA_CATALOG, UNLISTED_LAX_NOTE, laxDataEntry } from "./lax-data-catalog.js";

/**
 * The spelling the filesystem itself gives `p`, so a classifier sees the file
 * a write would reach. NTFS answers to more names than the one on disk: an
 * 8.3 short name for any segment (`LAX~1`, `HOOKS~1.JSO`) and a stream suffix
 * (`hooks.json::$DATA`, `.lax::$INDEX_ALLOCATION`). Node hands both to Windows
 * unchanged, so a write by either lands on the real file, while the JS
 * realpath (realpathDeep) keeps the spelling as typed. The native realpath
 * names every segment that exists by its long name. A stream suffix is
 * stripped first because a write to a file that does not exist yet creates
 * it, and then there is nothing on disk for the native call to name.
 */
export function onDiskSpelling(p: string): string {
  const start = process.platform === "win32" ? withoutStreamSuffixes(resolve(p)) : resolve(p);
  let cur = start;
  let tail = "";
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail ? join(real, tail) : real;
    } catch {
      // A segment that does not exist yet (a new file) or cannot be opened is
      // kept as typed, and its parent named instead.
      const parent = dirname(cur);
      if (parent === cur) return start;
      tail = tail ? join(basename(cur), tail) : basename(cur);
      cur = parent;
    }
  }
}

/** `C:\x\.lax::$INDEX_ALLOCATION\hooks.json::$DATA` → `C:\x\.lax\hooks.json`.
 *  A drive segment (`C:`) is the one place a colon belongs. */
function withoutStreamSuffixes(p: string): string {
  return p.split(/([\\/])/).map((seg) => (/^[a-z]:$/i.test(seg) ? seg : seg.replace(/:.*$/, ""))).join("");
}

/** True when every path segment before the basename contains a `.lax` dir. */
function underLaxDir(segs: string[]): boolean {
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i]?.toLowerCase() === ".lax") return true;
  }
  return false;
}

/**
 * The app's OWN at-rest secret/key/seed files under a `.lax` data dir.
 *
 * Derived from the ONE canonical enumeration (security/known-secrets.ts) so this
 * read gate / write block can never drift from the read-taint classifier or the
 * attachment denylist. Scoped to a `.lax` dir segment so a user file that happens
 * to be named e.g. `auth.json` outside the data dir isn't caught by THIS rule
 * (auth.json/master.* still match the cross-location SENSITIVE_PATTERNS in
 * file-access.ts where they already did) — the coverage this adds is
 * `audit-key` / `audit-key.enc` / `secrets.salt` under the app's data dir.
 */
export function isAppAtRestSecretUnderLax(p: string): boolean {
  const segs = p.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return false;
  const base = segs[segs.length - 1];
  if (base === undefined || !isAppAtRestSecretBasename(base)) return false;
  return underLaxDir(segs);
}

/**
 * `p`'s segments below the data dir, lowercased (Windows and macOS answer to
 * any casing), or null when `p` is not inside one. The data dir is known by
 * its `.lax` name, the outermost one, so a `.lax` folder inside the workspace
 * is the workspace's.
 */
function belowDataDir(p: string): string[] | null {
  const segs = p.split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
  const at = segs.indexOf(".lax");
  return at >= 0 && at < segs.length - 1 ? segs.slice(at + 1) : null;
}

/** Each spelling a classifier must judge `p` by: the file a write reaches
 *  first, so a card names it, then the spelling as given. */
function spellings(p: string): string[] {
  const onDisk = onDiskSpelling(p);
  return onDisk === p ? [p] : [onDisk, p];
}

/**
 * True when `p` is one of the security switches at its place in a `.lax` data
 * dir, by the spelling given or by the name it has on disk. Only at that
 * location: a user's own project `config.json` or `settings.json`, or one in
 * a workspace inside the data dir, is untouched.
 */
export function isLaxControlFile(p: string): boolean {
  return spellings(p).some((s) => {
    const below = belowDataDir(s);
    return below !== null && laxDataEntry(below)?.kind === "blocked";
  });
}

/** Where each switch sits under the data dir, "/"-separated (`cron/jobs.json`).
 *  Exported for the cross-seam contract test. */
export function laxControlFileBasenames(): string[] {
  return LAX_DATA_CATALOG.filter((e) => e.kind === "blocked").map((e) => e.rel.join("/"));
}

/**
 * The data-dir file `p` names, by the name it has on disk or by the spelling
 * given (`path` is whichever matched), with what it controls, or null when it
 * is the agent's own working data or not in the data dir at all. The app
 * reads back what it keeps there — as settings, schedules, code it loads,
 * programs it runs, the memory it reads into every chat — so a write by the
 * agent is put to the user, never made silently, unless the catalog lists the
 * location as working data. A location the catalog does not name is put to
 * the user too. Either spelling decides: a link inside the working data that
 * points at hooks.json writes hooks.json.
 */
export function laxApprovalGatedFile(p: string): { path: string; controls: string } | null {
  for (const s of spellings(p)) {
    const below = belowDataDir(s);
    const entry = below && laxDataEntry(below);
    if (below && entry?.kind !== "data") return { path: s, controls: entry?.note ?? UNLISTED_LAX_NOTE };
  }
  return null;
}

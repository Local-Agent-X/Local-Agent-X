/**
 * Whether the sync repository may be trusted with the user's data and sync
 * token. A sync pushes everything it mirrors (memory, chats, settings), pulls
 * what comes back into the data dir, and signs in with the vault's token. git
 * takes where that goes, and what runs on the way, from config: the sync
 * repository's own (.git/config) and the user's. A remote.origin.pushurl or a
 * url.*.insteadOf rule sends the push somewhere else while origin still names
 * the configured repository, and a filter, merge driver or credential setting
 * runs a program or reshapes the signed-in connection. Anything that can run a
 * shell command can write that config without naming the file.
 *
 * So before every sync:
 *  - the repository's own config may hold only what clone and sync write
 *    (SYNC_OWNED_KEY); sync writes nothing else there, so anything else came
 *    from something else, and sync stops and says what it found;
 *  - every URL git would fetch origin from and push origin to, after every
 *    rewrite rule at every scope, must be the configured repository (a user's
 *    own rule from https to ssh for the same repository is still it).
 */
import { gitErrorLine, runGit } from "../publish-review/git-exec.js";
import { isUserScope, readConfig } from "../publish-review/config-scope.js";

// What `git clone`, `git remote set-url origin` and `git push -u origin` write.
const SYNC_OWNED_KEY = new RegExp(
  "^(?:core\\.(?:repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|precomposeunicode)"
  + "|remote\\.origin\\.(?:url|fetch)|branch\\..+\\.(?:remote|merge))$",
  "i",
);

// A URL's user info can carry a token, and so can a url.<base> subsection.
const shownUrl = (url: string): string => url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, "$1");
const shownKey = (key: string): string => key.replace(/^([^.]*)\..*\.([^.]*)$/, "$1.*.$2");

const RECOVERY = "If you did not set it, something on this computer did. Delete the sync-repo folder and sync again: sync clones a fresh copy and copies your data back into it.";

/**
 * `host/path` of a repository URL, lower-cased, without user info, port or a
 * trailing `.git`: the same repository reached over https, ssh or scp-like
 * `user@host:path` gives the same key. null for anything else (a local path).
 */
export function repositoryKey(url: string): string | null {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)(?::\d*)?\/(.*)$/.exec(url)
    ?? /^(?:[^/@:]*@)?([^/:\\]{2,}):(?!\/\/)(.*)$/.exec(url);
  if (!m) return null;
  const path = m[2].replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^\/+/, "");
  return path ? `${m[1]}/${path}`.toLowerCase() : null;
}

/** Why the sync repository's own config cannot be trusted, or null. */
async function foreignConfig(syncDir: string): Promise<string | null> {
  const read = await readConfig(syncDir, ".");
  if (!read.ok) return `Sync stopped: git could not read the sync repository's config (${read.reason}).`;
  // "command" is this check's own -c hardening.
  const foreign = read.entries.find((e) => !isUserScope(e.scope) && e.scope !== "command" && !SYNC_OWNED_KEY.test(e.key));
  if (!foreign) return null;
  return `Sync stopped: the sync repository's git config (${foreign.scope}) sets ${shownKey(foreign.key)}, which sync never writes. `
    + `Set there, it can send your data somewhere other than your sync repository, or run a program during a sync. ${RECOVERY}`;
}

/** Why git would fetch or push origin somewhere other than `repoUrl`, or null. */
async function foreignDestination(syncDir: string, repoUrl: string): Promise<string | null> {
  const want = repositoryKey(repoUrl);
  for (const direction of ["fetch", "push"] as const) {
    const r = await runGit(syncDir, ["remote", "get-url", ...(direction === "push" ? ["--push"] : []), "--all", "origin"]);
    if (r.code !== 0) return `Sync stopped: git could not say where the sync repository ${direction}es to (${gitErrorLine(r)}).`;
    const urls = r.stdout.split(/\r?\n/).filter(Boolean);
    const elsewhere = urls.find((u) => (want === null ? u !== repoUrl : repositoryKey(u) !== want));
    if (urls.length === 1 && elsewhere === undefined) continue;
    const shown = urls.map(shownUrl).join(", ") || "nowhere";
    return `Sync stopped: git would ${direction} your sync data ${direction === "push" ? "to" : "from"} ${shown}, not ${shownUrl(repoUrl)}. `
      + "A url.*.insteadOf rule in your git config redirects it (`git config --show-origin --get-regexp \"^url\\.\"` shows where it is set). "
      + "If you did not set it, something on this computer did: remove it and sync again.";
  }
  return null;
}

/** Why a sync must not run in `syncDir`, or null when it may. */
export async function syncRepoRefusal(syncDir: string, repoUrl: string): Promise<string | null> {
  return (await foreignConfig(syncDir)) ?? (await foreignDestination(syncDir, repoUrl));
}

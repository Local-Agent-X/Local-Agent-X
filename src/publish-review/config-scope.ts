/**
 * git config entries with the scope git read each one from, so the
 * pre-approval push review can tell the user's own config (system and global)
 * from the repository's. git reports an included file at the scope of the file
 * that included it, so a repository cannot pass its config off as the user's
 * through include.path or includeIf.
 */
import { gitErrorLine, runGit } from "./git-exec.js";

export interface ConfigEntry {
  scope: string;
  key: string;
  /** null for a key written with no `=`, which git reads as true. */
  value: string | null;
}

export type ConfigRead = { ok: true; entries: ConfigEntry[] } | { ok: false; reason: string };

export const isUserScope = (scope: string): boolean => scope === "system" || scope === "global";

/** Every entry whose key matches the extended regexp `pattern`, in the order
 *  git reads them: system, global, then the repository's. */
export async function readConfig(cwd: string, pattern: string): Promise<ConfigRead> {
  const r = await runGit(cwd, ["config", "--show-scope", "-z", "--get-regexp", pattern]);
  // git exits 1, printing nothing, when no key matches.
  if (r.code === 1 && r.stdout === "") return { ok: true, entries: [] };
  // The repository's entries come last, so a cut-off list loses exactly those.
  if (r.truncated) return { ok: false, reason: "the matching config is larger than the review reads" };
  if (r.code !== 0) return { ok: false, reason: gitErrorLine(r) };
  // -z prints each entry as `<scope>\0<key>\n<value>\0`, the newline and
  // value left out for a key with no value.
  const fields = r.stdout.split("\0");
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const nl = fields[i + 1].indexOf("\n");
    entries.push({
      scope: fields[i],
      key: nl < 0 ? fields[i + 1] : fields[i + 1].slice(0, nl),
      value: nl < 0 ? null : fields[i + 1].slice(nl + 1),
    });
  }
  return { ok: true, entries };
}

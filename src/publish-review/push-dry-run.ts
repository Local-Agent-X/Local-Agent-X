/**
 * Ask git which refs a `git push` would update, without updating them:
 * `git push --dry-run --porcelain` with the agent's own arguments, in the
 * command's directory. This is the only way to get the exact answer — the
 * refspec, push.default, remote.*.push, a `HEAD:refs/heads/x` destination and
 * `--tags`/`--all`/`--mirror` all resolve inside git, and re-implementing that
 * resolution would drift from it.
 *
 * The dry run contacts the remote (to learn its current refs) but runs nothing
 * there: pre-push hooks are skipped (--no-verify) and submodules are not
 * recursed. Arguments that would make git EXECUTE a program (--receive-pack /
 * --exec) are refused rather than run before the user approved anything.
 */
import { gitErrorLine, runGit, GIT_REMOTE_TIMEOUT_MS } from "./git-exec.js";
import type { RefUpdate } from "./change-set-types.js";

/** Push options the dry run supplies itself, or must not pass through. */
// -u/--set-upstream changes local config and says nothing about which refs move.
const STRIPPED = /^(?:--dry-run|-n|--porcelain|--verify|--no-verify|--recurse-submodules(?:=.*)?|--no-recurse-submodules|-q|--quiet|-v|--verbose|--progress|--no-progress|-u|--set-upstream)$/;
const EXECUTES_PROGRAM = /^(?:--receive-pack|--exec)(?:=|$)/;

export type DryRunResult = { ok: true; refs: RefUpdate[] } | { ok: false; reason: string };

export async function pushDryRun(cwd: string, pushArgs: string[]): Promise<DryRunResult> {
  if (pushArgs.some((a) => EXECUTES_PROGRAM.test(a))) {
    return { ok: false, reason: "the push names a custom --receive-pack/--exec program, which a dry run would execute; not run before approval" };
  }
  const args = ["push", "--dry-run", "--porcelain", "--no-verify", "--recurse-submodules=no", ...pushArgs.filter((a) => !STRIPPED.test(a))];
  const r = await runGit(cwd, args, { timeoutMs: GIT_REMOTE_TIMEOUT_MS });
  const refs = parsePorcelain(r.stdout);
  // A push with a rejected ref exits non-zero but still reports every ref.
  if (refs.length === 0 && (r.code !== 0 || r.missing || r.timedOut)) {
    return { ok: false, reason: `git push --dry-run failed: ${gitErrorLine(r)}` };
  }
  return { ok: true, refs };
}

/**
 * Parse `git push --porcelain` output:
 *   To <url>
 *   <flag>\t<from>:<to>\t<summary> (<reason>)
 *   Done
 * flag: ' ' fast-forward, '+' forced, '-' deleted, '*' new, '!' rejected,
 * '=' up to date. The summary carries abbreviated shas for updates
 * (`old..new`, `old...new`); callers resolve them to full shas.
 */
export function parsePorcelain(stdout: string): RefUpdate[] {
  const refs: RefUpdate[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([ +\-*!=])\t([^\t]*)\t(.*)$/.exec(line);
    if (!m) continue;
    const [, flag, spec, summary] = m;
    const colon = spec.lastIndexOf(":");
    const localRef = colon >= 0 ? spec.slice(0, colon) : "";
    const remoteRef = colon >= 0 ? spec.slice(colon + 1) : spec;
    const range = /^([0-9a-f]{4,64})\.\.\.?([0-9a-f]{4,64})/.exec(summary);
    const note = /\(([^)]*)\)\s*$/.exec(summary)?.[1];
    const status: RefUpdate["status"] =
      flag === "*" ? "new" : flag === "+" ? "forced" : flag === "-" ? "deleted"
        : flag === "!" ? "rejected" : flag === "=" ? "up-to-date" : "fast-forward";
    refs.push({
      remoteRef,
      localRef,
      status,
      ...(range ? { oldSha: range[1], newSha: range[2] } : {}),
      ...(status === "rejected" && note ? { note } : {}),
    });
  }
  return refs;
}

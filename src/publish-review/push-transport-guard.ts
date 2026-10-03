/**
 * Where a pre-approval `git push --dry-run` would connect, checked before it
 * connects. The dry run runs on the host, in the agent's repository, so that
 * repository's config decides where it goes and what it starts:
 *   - a local path or file:// remote makes git run receive-pack, and the
 *     target repository's own config, on this machine;
 *   - a `<helper>::` address or remote.<name>.vcs starts git-remote-<helper>;
 *   - remote.<name>.receivepack names the program run at the other end;
 *   - url.<base>.insteadOf / pushInsteadOf send a push for one URL to another.
 * A rewrite rule from the user's own config (system or global) is the user's
 * word on where that URL lives, so the push is checked at the URL it produces,
 * as it would be had they written that URL; the push is refused when the rule
 * git applies comes from the repository or the command line. Only a network
 * transport gets through. git:// is refused with the local ones: core.gitProxy
 * runs a command for it, and git keeps the FIRST value it reads, so a
 * command-line override cannot displace one the repository sets.
 */
import { runGit } from "./git-exec.js";
import { isUserScope, readConfig } from "./config-scope.js";

const NETWORK_SCHEMES = new Set(["https", "http", "ssh", "git+ssh", "ssh+git"]);

/** True when `arg` is the long option `--<full>` or an abbreviation of it at
 *  least `min` characters long, with or without `=value`: git's option parser
 *  accepts any unambiguous prefix, so `--rece` is `--receive-pack`. */
export function isLongOption(arg: string, full: string, min: number): boolean {
  if (!arg.startsWith("--")) return false;
  const name = arg.slice(2).split("=", 1)[0];
  return name.length >= min && full.startsWith(name);
}

/**
 * A URL git reaches over the network: https, http, ssh, and the scp-like
 * `[user@]host:path`, told apart the way git's transport_get and
 * url_is_local_not_ssh tell them. A `<helper>::` address, any other scheme,
 * and a path (no colon, a slash before the first colon, or a drive letter)
 * all run something on this machine.
 */
export function isNetworkTransport(url: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme) return NETWORK_SCHEMES.has(scheme[1]);
  const colon = url.indexOf(":");
  const slash = url.search(/[\\/]/);
  if (colon <= 0 || (slash >= 0 && slash < colon)) return false;
  return !/^[A-Za-z]:/.test(url);
}

/**
 * The <repository> a push names, found the way git's option parser finds it:
 * the first operand, else --repo. Skips the value of every option that takes
 * one as a separate argument (-o, --push-option, --repo), including inside a
 * short-option cluster such as `-fo <value>`.
 */
export function repositoryArg(args: string[]): string | null {
  let repo: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--" || a === "--end-of-options") return args[i + 1] ?? repo;
    if (!a.startsWith("-") || a === "-") return a;
    if (a.startsWith("--")) {
      const inline = a.includes("=");
      if (isLongOption(a, "repo", 3)) repo = inline ? a.slice(a.indexOf("=") + 1) : (args[++i] ?? null);
      else if (isLongOption(a, "push-option", 2) && !inline) i++;
      continue;
    }
    // Every short push option is a flag except -o, whose value is the rest
    // of the cluster or, when -o ends it, the next argument.
    if (a.indexOf("o") === a.length - 1) i++;
  }
  return repo;
}

async function lines(cwd: string, args: string[]): Promise<string[] | null> {
  const r = await runGit(cwd, args);
  return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : null;
}

// A URL's user info can carry a token.
const shownUrl = (url: string): string => url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, "$1");

type RewriteKind = "insteadof" | "pushinsteadof";
/** url.<base>.<kind> = <prefix>: a URL starting with `prefix` is sent to `base` + the rest. */
interface Rewrite { base: string; prefix: string; kind: RewriteKind; scope: string }
type Rewrites = Record<RewriteKind, Rewrite[]>;
const KIND_NAME: Record<RewriteKind, string> = { insteadof: "insteadOf", pushinsteadof: "pushInsteadOf" };

/** Every rewrite rule, each kind in git's order: by base as first read, then
 *  by value (remote.c make_rewrite / add_instead_of). git ignores a rule with
 *  no base, and so does the pattern. */
async function readRewrites(cwd: string): Promise<Rewrites | string> {
  const read = await readConfig(cwd, "^url\\..*\\.(push)?insteadof$");
  if (!read.ok) return `git could not read the url.*.insteadOf rules (${read.reason})`;
  const byBase = { insteadof: new Map<string, Rewrite[]>(), pushinsteadof: new Map<string, Rewrite[]>() };
  for (const { scope, key, value } of read.entries) {
    const dot = key.lastIndexOf(".");
    const kind = key.slice(dot + 1) as RewriteKind;
    const base = key.slice("url.".length, dot);
    const rules = byBase[kind].get(base) ?? [];
    rules.push({ base, prefix: value ?? "", kind, scope });
    byBase[kind].set(base, rules);
  }
  return { insteadof: [...byBase.insteadof.values()].flat(), pushinsteadof: [...byBase.pushinsteadof.values()].flat() };
}

/** The rule git applies to `url`: the longest matching prefix, the earliest in
 *  readRewrites' order on a tie (remote.c alias_url). */
function ruleFor(rules: Rewrite[], url: string): Rewrite | null {
  let best: Rewrite | null = null;
  for (const r of rules) if (url.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
  return best;
}

interface PushTarget { from: string; url: string; rule: Rewrite | null }
const through = (from: string, rule: Rewrite | null): PushTarget =>
  ({ from, url: rule ? rule.base + from.slice(rule.prefix.length) : from, rule });

/** Where git pushes a remote with these pushurl and url values (a URL named
 *  on the command line is a remote with it as its one url), and the rule
 *  behind each: a pushurl goes through insteadOf only; with none, the urls a
 *  pushInsteadOf matches are pushed through it, and only when it matches none
 *  do the urls go through insteadOf (remote.c alias_all_urls). */
function pushTargets(pushurls: string[], urls: string[], rewrites: Rewrites): PushTarget[] {
  if (pushurls.length > 0) return pushurls.map((u) => through(u, ruleFor(rewrites.insteadof, u)));
  const pushed = urls.flatMap((u) => {
    const rule = ruleFor(rewrites.pushinsteadof, u);
    return rule ? [through(u, rule)] : [];
  });
  return pushed.length > 0 ? pushed : urls.map((u) => through(u, ruleFor(rewrites.insteadof, u)));
}

type Resolved = { urls: string[] } | { refusal: string };

/** Where a push to `dest` goes, or why it must not be dry-run. A configured
 *  remote is read through its own keys, and the URLs worked out from them must
 *  be the ones git reports; anything else is a URL git is handed directly
 *  (`asUrl`). A name that is neither, when not `asUrl`, goes nowhere: git
 *  refuses it too. */
async function resolveDestination(cwd: string, dest: string, asUrl: boolean, rewrites: Rewrites): Promise<Resolved> {
  const reported = await lines(cwd, ["remote", "get-url", "--push", "--all", dest]);
  let targets: PushTarget[];
  if (reported) {
    for (const key of ["vcs", "receivepack"]) {
      const value = (await lines(cwd, ["config", "--get", `remote.${dest}.${key}`]))?.[0];
      if (value) return { refusal: `the remote "${dest}" sets remote.${dest}.${key}=${value}, a program the dry run would start` };
    }
    const pushurls = (await lines(cwd, ["config", "--get-all", `remote.${dest}.pushurl`])) ?? [];
    const urls = (await lines(cwd, ["config", "--get-all", `remote.${dest}.url`])) ?? [];
    targets = pushTargets(pushurls, urls, rewrites);
    if (targets.length !== reported.length || targets.some((t, i) => t.url !== reported[i])) {
      return { refusal: `git would push "${dest}" to ${reported.map(shownUrl).join(", ") || "nothing"}, not the ${targets.map((t) => shownUrl(t.url)).join(", ") || "no URL"} its configuration and url.*.insteadOf / pushInsteadOf rules name` };
    }
  } else if (asUrl) {
    targets = pushTargets([], [dest], rewrites);
  } else {
    return { urls: [] };
  }
  const foreign = targets.find((t) => t.rule && !isUserScope(t.rule.scope));
  if (foreign?.rule) {
    return { refusal: `a url.*.${KIND_NAME[foreign.rule.kind]} rule in the ${foreign.rule.scope} git config, not the user's own, rewrites the push URL ${shownUrl(foreign.from)}` };
  }
  const local = targets.find((t) => !isNetworkTransport(t.url));
  if (local) return { refusal: `the push goes to ${shownUrl(local.url)}, which is not an https/ssh remote: a local path, file://, git:// or remote-helper transport runs on this machine` };
  return { urls: targets.map((t) => t.url) };
}

/** The candidates git picks a push destination from when the push names none:
 *  the current branch's pushRemote and remote, and remote.pushDefault (git's
 *  order among them is not relied on, all are checked); with none of those
 *  set, every configured remote plus "origin". */
async function defaultDestinations(cwd: string): Promise<Array<{ dest: string; asUrl: boolean }>> {
  const branch = (await lines(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]))?.[0];
  const keys = [...(branch ? [`branch.${branch}.pushRemote`, `branch.${branch}.remote`] : []), "remote.pushDefault"];
  const chosen: string[] = [];
  for (const key of keys) {
    const value = (await lines(cwd, ["config", "--get", key]))?.[0];
    if (value) chosen.push(value);
  }
  if (chosen.length > 0) return chosen.map((dest) => ({ dest, asUrl: true }));
  const remotes = (await lines(cwd, ["remote"])) ?? [];
  return [...new Set([...remotes, "origin"])].map((dest) => ({ dest, asUrl: false }));
}

/** Every URL the push these (already filtered) arguments describe could go
 *  to, or why one of them must not be dry-run. */
async function resolvePush(cwd: string, args: string[]): Promise<Resolved> {
  const rewrites = await readRewrites(cwd);
  if (typeof rewrites === "string") return { refusal: rewrites };
  const explicit = repositoryArg(args);
  const dests = explicit === null ? await defaultDestinations(cwd) : [{ dest: explicit, asUrl: true }];
  const urls: string[] = [];
  for (const { dest, asUrl } of dests) {
    const resolved = await resolveDestination(cwd, dest, asUrl, rewrites);
    if ("refusal" in resolved) return resolved;
    urls.push(...resolved.urls);
  }
  return { urls };
}

/** Why the push these (already filtered) arguments describe must not be
 *  dry-run before approval, or null when every destination it could reach is
 *  a network remote, at the URL its configuration names or the user's own
 *  rewrite rules make of it. */
export async function refusePushTransport(cwd: string, args: string[]): Promise<string | null> {
  const resolved = await resolvePush(cwd, args);
  return "refusal" in resolved ? `${resolved.refusal}; not run before approval` : null;
}

/** The URLs a push refusePushTransport let through could go to. */
export async function pushUrls(cwd: string, args: string[]): Promise<string[]> {
  const resolved = await resolvePush(cwd, args);
  return "urls" in resolved ? resolved.urls : [];
}

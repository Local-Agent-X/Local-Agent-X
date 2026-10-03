/**
 * The table of commands that PUBLISH — ship code or artifacts to a place other
 * people consume. Read by publish-operation.ts, which owns the shell walk (the
 * command positions, the working directory each one runs in); this module only
 * answers "given this argv, starting at the real command word, is it a publish,
 * and of what kind?".
 *
 * Every matcher is argv-positional, never a substring: `git log`, `grep deploy`
 * and `echo "git push"` are not publishes, and a quoted argument that happens to
 * contain `npm publish` is one word, not a command.
 */
import { resolveRealArgv0Index } from "./security/layer/shell-lex.js";

export type PublishKind = "git-push" | "deploy" | "package-publish" | "release";

/** One of git's own options, given before the subcommand. */
export interface GitOption {
  /** As git reads it: `-c`, `-C`, `--git-dir`, `--no-pager`. */
  name: string;
  /** Its value: the next word, or what follows `=` on a long option. */
  value?: string;
}

export interface PublishMatch {
  kind: PublishKind;
  /** `git push`, `vercel deploy --prod`, `npm publish` — for the card. */
  label: string;
  /** git-push: the words after `push`, exactly as the agent wrote them. */
  pushArgs?: string[];
  /** git-push: git's own options before `push`, in order. */
  gitOptions?: GitOption[];
  /** git-push: names of the variables assigned in front of git on its own
   *  command (`GIT_SSH_COMMAND=… git push`, `env GIT_DIR=… git push`). */
  gitEnv?: string[];
  /** A directory the command itself selects (`git -C dir`, `vercel --cwd dir`). */
  dirArg?: string;
  /** gh pr merge: the PR it names; gh release create: the tag. */
  explicitTarget?: string;
}

/** `NAME=value` or `NAME+=value`: a shell assignment; group 1 is the name. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

/** The names a run of assignment words sets. */
export function assignedNames(words: string[]): string[] {
  return words.flatMap((w) => ASSIGNMENT.exec(w)?.[1] ?? []);
}

/**
 * Index of the command a position runs when its first words are assignments
 * (`GIT_SSH_COMMAND=… git push`, `A=1 env git push`): the shell runs the word
 * after them, which the position walk does not skip. `words.length` when
 * nothing runs after them, so they stay set for the rest of the shell body.
 */
export function pastAssignments(words: string[], at: number): number {
  let i = at;
  while (i < words.length && ASSIGNMENT.test(words[i])) i++;
  if (i === at) return at;
  const real = resolveRealArgv0Index(words.slice(i));
  return real === null ? words.length : i + real;
}

/** Strip a Windows launcher extension (`vercel.cmd` is `vercel`) and a package
 *  runner's version pin (`npx vercel@latest` runs `vercel`). */
export function normalizeBin(bin: string): string {
  return bin.replace(/\.(cmd|bat|ps1)$/, "").replace(/(?<=.)@[^/]*$/, "");
}

/** Words after `start` that are not flags (and not the value of a known
 *  value-taking flag). `valueFlags` lists flags whose value is the NEXT word. */
function positionals(words: string[], start: number, valueFlags: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  for (let i = start; i < words.length; i++) {
    const w = words[i];
    if (w === "--") { out.push(...words.slice(i + 1)); break; }
    if (w.startsWith("-")) {
      if (!w.includes("=") && valueFlags.has(w)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

function hasFlag(words: string[], start: number, ...flags: string[]): boolean {
  return words.slice(start).some((w) => flags.some((f) => w === f || w.startsWith(`${f}=`)));
}

function flagValue(words: string[], start: number, flag: string): string | undefined {
  for (let i = start; i < words.length; i++) {
    if (words[i] === flag) return words[i + 1];
    if (words[i].startsWith(`${flag}=`)) return words[i].slice(flag.length + 1);
  }
  return undefined;
}

const isDryRun = (words: string[], start: number) => hasFlag(words, start, "--dry-run");
const isHelp = (words: string[], start: number) => hasFlag(words, start, "--help", "-h");

// git's global options that take the NEXT word as their value (the long ones
// also take `=value`). One missing here hides the push: its value would be
// read as the subcommand.
const GIT_GLOBAL_VALUE_OPTS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix", "--attr-source", "--shallow-file",
]);

function matchGit(words: string[], at: number): PublishMatch | null {
  let i = at + 1;
  let dirArg: string | undefined;
  const gitOptions: GitOption[] = [];
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    const option: GitOption = eq > 0 ? { name: w.slice(0, eq), value: w.slice(eq + 1) }
      : GIT_GLOBAL_VALUE_OPTS.has(w) ? { name: w, value: words[++i] } : { name: w };
    if (option.name === "-C") dirArg = option.value;
    gitOptions.push(option);
    i++;
  }
  if (words[i] !== "push") return null;
  const pushArgs = words.slice(i + 1);
  // A dry run publishes nothing; --help prints a man page.
  if (pushArgs.some((w) => w === "--dry-run" || w === "-n" || w === "--help" || w === "-h")) return null;
  const gitEnv = assignedNames(words.slice(0, at));
  return {
    kind: "git-push", label: ["git push", ...pushArgs].join(" "), pushArgs, dirArg,
    ...(gitOptions.length ? { gitOptions } : {}),
    ...(gitEnv.length ? { gitEnv } : {}),
  };
}

// A package.json script with one of these names ships something: `npm run
// deploy`, `pnpm run release:prod`, `yarn publish:docs`.
const SHIPPING_SCRIPT = /^(deploy|release|publish)(?:[:-].*)?$/;

function matchPackageManager(bin: string, words: string[], at: number): PublishMatch | null {
  const args = positionals(words, at + 1);
  const sub = args[0];
  if (!sub || isHelp(words, at + 1)) return null;
  // `yarn npm publish` (Berry) is the same publish one level down.
  const publishes = sub === "publish" || (bin === "yarn" && sub === "npm" && args[1] === "publish");
  if (publishes) {
    return isDryRun(words, at + 1) ? null : { kind: "package-publish", label: `${bin} publish` };
  }
  const script = sub === "run" || sub === "run-script" ? args[1] : bin === "yarn" ? sub : undefined;
  if (script && SHIPPING_SCRIPT.test(script)) return { kind: "deploy", label: `${bin} run ${script}` };
  return null;
}

// Vercel: a bare `vercel` (or `vercel <dir>`) deploys; so does `vercel deploy`.
// Every other first word is a subcommand that does not ship new code.
const VERCEL_NON_DEPLOY = new Set([
  "alias", "bisect", "blob", "build", "cache", "certs", "dev", "dns", "domains", "env", "git", "help", "init",
  "inspect", "install", "integration", "link", "list", "login", "logout", "logs", "ls", "mcp", "microfrontends",
  "open", "project", "projects", "promote", "pull", "redeploy", "remove", "rm", "rollback", "secrets", "switch",
  "target", "teams", "telemetry", "whoami",
]);
const VERCEL_VALUE_FLAGS = new Set([
  "--scope", "-S", "--token", "-t", "--cwd", "--local-config", "-A", "--global-config", "-Q", "--env", "-e",
  "--build-env", "-b", "--meta", "-m", "--regions", "--archive", "--target", "--team", "-T",
]);

function matchVercel(words: string[], at: number): PublishMatch | null {
  if (hasFlag(words, at + 1, "--version", "-v", "--help", "-h")) return null;
  const first = positionals(words, at + 1, VERCEL_VALUE_FLAGS)[0];
  if (first !== undefined && first !== "deploy" && VERCEL_NON_DEPLOY.has(first)) return null;
  const prod = hasFlag(words, at + 1, "--prod");
  return { kind: "deploy", label: `vercel${first === "deploy" ? " deploy" : ""}${prod ? " --prod" : ""}`, dirArg: flagValue(words, at + 1, "--cwd") };
}

/** `<bin> <sub...>` pairs that deploy. Matched on the leading positionals. */
const SUBCOMMAND_DEPLOYS: ReadonlyArray<{ bins: string[]; sub: string[]; kind: PublishKind }> = [
  { bins: ["netlify", "ntl"], sub: ["deploy"], kind: "deploy" },
  { bins: ["supabase"], sub: ["functions", "deploy"], kind: "deploy" },
  { bins: ["supabase"], sub: ["db", "push"], kind: "deploy" },
  { bins: ["wrangler"], sub: ["deploy"], kind: "deploy" },
  { bins: ["wrangler"], sub: ["publish"], kind: "deploy" },
  { bins: ["wrangler"], sub: ["pages", "deploy"], kind: "deploy" },
  { bins: ["wrangler"], sub: ["pages", "publish"], kind: "deploy" },
  { bins: ["wrangler"], sub: ["versions", "deploy"], kind: "deploy" },
  { bins: ["firebase"], sub: ["deploy"], kind: "deploy" },
  { bins: ["fly", "flyctl"], sub: ["deploy"], kind: "deploy" },
  { bins: ["eas"], sub: ["submit"], kind: "deploy" },
  // An over-the-air update ships a JS bundle straight to installed apps.
  { bins: ["eas"], sub: ["update"], kind: "deploy" },
  { bins: ["cargo"], sub: ["publish"], kind: "package-publish" },
  { bins: ["docker", "podman"], sub: ["push"], kind: "package-publish" },
  { bins: ["docker", "podman"], sub: ["image", "push"], kind: "package-publish" },
  { bins: ["gh"], sub: ["release", "create"], kind: "release" },
  { bins: ["gh"], sub: ["pr", "merge"], kind: "release" },
];

const SUBCOMMAND_VALUE_FLAGS = new Set([
  "--project", "-p", "--config", "-c", "--profile", "-a", "--app", "--env", "-e", "--repo", "-R",
  // gh pr merge / gh release create
  "--body", "-b", "--body-file", "-F", "--subject", "-t", "--author-email", "-A", "--match-head-commit",
  "--title", "--notes", "-n", "--notes-file", "--target", "--discussion-category",
]);

function matchSubcommandTable(bin: string, words: string[], at: number): PublishMatch | null {
  if (isHelp(words, at + 1)) return null;
  const args = positionals(words, at + 1, SUBCOMMAND_VALUE_FLAGS);
  for (const row of SUBCOMMAND_DEPLOYS) {
    if (!row.bins.includes(bin)) continue;
    if (!row.sub.every((w, i) => args[i] === w)) continue;
    if (row.kind === "package-publish" && bin === "cargo" && isDryRun(words, at + 1)) return null;
    const label = [bin, ...row.sub].join(" ");
    // gh pr merge <pr> / gh release create <tag>: the object it acts on.
    if (bin === "gh") {
      const target = args[row.sub.length];
      return { kind: row.kind, label, ...(target ? { explicitTarget: target } : {}) };
    }
    return { kind: row.kind, label };
  }
  // `eas build --auto-submit` submits the build it makes to the stores.
  if (bin === "eas" && args[0] === "build" && hasFlag(words, at + 1, "--auto-submit", "--auto-submit-with-profile")) {
    return { kind: "deploy", label: "eas build --auto-submit" };
  }
  // `docker buildx build --push` pushes the image it builds.
  if ((bin === "docker" || bin === "podman") && args[0] === "buildx" && args[1] === "build" && hasFlag(words, at + 1, "--push")) {
    return { kind: "package-publish", label: `${bin} buildx build --push` };
  }
  return null;
}

/** Is the argv at `at` (the real command word) a publish? */
export function matchPublishArgv(words: string[], at: number): PublishMatch | null {
  const bin = normalizeBin(words[at]?.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "") ?? "");
  if (bin === "git") return matchGit(words, at);
  if (bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") return matchPackageManager(bin, words, at);
  if (bin === "vercel") return matchVercel(words, at);
  return matchSubcommandTable(bin, words, at);
}

// Package runners put the real command one word later: `npx vercel deploy`,
// `pnpm dlx wrangler deploy`, `npm exec -- netlify deploy`, `bunx eas submit`.
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);

/** Index of the command a package runner will run, or `at` when `words[at]`
 *  is not a runner. */
export function unwrapPackageRunner(words: string[], at: number): number {
  const bin = normalizeBin((words[at] ?? "").replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, ""));
  let i: number;
  if (bin === "npx" || bin === "bunx" || bin === "pnpx") i = at + 1;
  else if ((bin === "pnpm" || bin === "yarn") && (words[at + 1] === "dlx" || words[at + 1] === "exec")) i = at + 2;
  else if (bin === "npm" && words[at + 1] === "exec") i = at + 2;
  else if (bin === "bun" && words[at + 1] === "x") i = at + 2;
  else return at;
  while (i < words.length && words[i].startsWith("-")) {
    if (words[i] === "--") { i++; break; }
    i += RUNNER_VALUE_FLAGS.has(words[i]) ? 2 : 1;
  }
  return i < words.length ? i : at;
}

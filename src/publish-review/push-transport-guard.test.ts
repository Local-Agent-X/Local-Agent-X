/**
 * A url.<base>.insteadOf / pushInsteadOf rule rewrites where a push goes. The
 * guard follows the one rule git applies (the longest matching prefix, the
 * base read first on a tie, pushInsteadOf before insteadOf for a push, and
 * insteadOf alone for an explicit pushurl) and lets the push through at the
 * rewritten URL only when that rule is the user's own (system or global
 * config). The user's config files are each test's own (GIT_CONFIG_SYSTEM /
 * GIT_CONFIG_GLOBAL). For a configured remote, git's own answer is compared
 * with the guard's, so a refusal naming the rule's scope rather than "git
 * would push ... to" shows the guard picked the rule git did.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushUrls, refusePushTransport } from "./push-transport-guard.js";

const REMOTE_URL = "https://example.invalid/acme/app.git";
let root = "";
let work = "";
let systemConfig = "";
let globalConfig = "";
const saved = { system: process.env.GIT_CONFIG_SYSTEM, global: process.env.GIT_CONFIG_GLOBAL };

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

const user = (scope: "system" | "global", key: string, value: string): void =>
  git(root, "config", "-f", scope === "system" ? systemConfig : globalConfig, "--add", key, value);
const repo = (key: string, value: string): void => git(work, "config", "--add", key, value);
const slashes = (p: string): string => p.replace(/\\/g, "/");

/** What the guard says about a push of `args`: its refusal, else the URLs it goes to. */
async function guard(args: string[]): Promise<string | string[]> {
  return (await refusePushTransport(work, args)) ?? pushUrls(work, args);
}

async function withEnv(vars: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { await body(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lax-push-guard-"));
  systemConfig = join(root, "system.gitconfig");
  globalConfig = join(root, "global.gitconfig");
  writeFileSync(systemConfig, "");
  writeFileSync(globalConfig, "");
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  work = join(root, "work");
  git(root, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", REMOTE_URL);
});

afterEach(() => {
  for (const [name, value] of [["GIT_CONFIG_SYSTEM", saved.system], ["GIT_CONFIG_GLOBAL", saved.global]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("a rewrite rule from the user's own config is followed like a URL they wrote", () => {
  it("a system or global insteadOf / pushInsteadOf, on a remote's URL or a URL named directly", async () => {
    for (const scope of ["system", "global"] as const) {
      for (const kind of ["insteadOf", "pushInsteadOf"]) {
        writeFileSync(systemConfig, "");
        writeFileSync(globalConfig, "");
        user(scope, `url.https://mirror.example/.${kind}`, "https://example.invalid/");
        for (const args of [["origin", "main"], [REMOTE_URL, "main"]]) {
          expect(await guard(args), `${scope} ${kind} ${args[0]}`).toEqual(["https://mirror.example/acme/app.git"]);
        }
      }
    }
  });

  it("the destination git picks when the push names none", async () => {
    user("global", "url.https://mirror.example/.pushInsteadOf", "https://example.invalid/");
    expect(await guard([])).toEqual(["https://mirror.example/acme/app.git"]);
  });

  it("still refuses a user's rule that sends the push to this machine", async () => {
    user("global", `url.${slashes(join(root, "elsewhere"))}/.insteadOf`, "https://example.invalid/");
    expect(await guard(["origin", "main"])).toMatch(/goes to .*\/elsewhere\/acme\/app\.git, which is not an https\/ssh remote/);
  });
});

describe("the push is refused when the rule git applies is the repository's or the command line's", () => {
  it("a repository rule, on a remote's URL or a URL named directly", async () => {
    repo("url.https://evil.example/.pushInsteadOf", "https://example.invalid/");
    for (const args of [["origin", "main"], [REMOTE_URL, "main"]]) {
      expect(await guard(args)).toMatch(/^a url\.\*\.pushInsteadOf rule in the local git config, not the user's own, rewrites the push URL https:\/\/example\.invalid\/acme\/app\.git; not run before approval$/);
    }
  });

  it("a command-line rule from the server's environment", async () => {
    await withEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://evil.example/.insteadOf", GIT_CONFIG_VALUE_0: "https://example.invalid/" }, async () => {
      expect(await guard(["origin", "main"])).toMatch(/url\.\*\.insteadOf rule in the command git config/);
    });
  });

  it("the longest matching prefix wins, whichever config holds it", async () => {
    user("global", "url.https://mirror.example/.insteadOf", "https://example.invalid/");
    repo("url.https://evil.example/.insteadOf", "https://example.invalid/acme/");
    expect(await guard([REMOTE_URL, "main"])).toMatch(/insteadOf rule in the local git config/);
    expect(await guard(["origin", "main"])).toMatch(/insteadOf rule in the local git config/);
    git(work, "config", "--unset-all", "url.https://evil.example/.insteadOf");
    repo("url.https://evil.example/.insteadOf", "https://example.");
    expect(await guard([REMOTE_URL, "main"])).toEqual(["https://mirror.example/acme/app.git"]);
    expect(await guard(["origin", "main"])).toEqual(["https://mirror.example/acme/app.git"]);
  });

  it("on a tie, the rule whose base git read first, not the first rule read", async () => {
    user("global", "url.https://mirror.example/.insteadOf", "https://example.invalid/");
    repo("url.https://evil.example/.insteadOf", "https://example.invalid/");
    expect(await guard(["origin", "main"])).toEqual(["https://mirror.example/acme/app.git"]);
    writeFileSync(globalConfig, "");
    // The repository's rule joins a base the user's config created first.
    user("global", "url.https://evil.example/.insteadOf", "https://unrelated.invalid/");
    user("global", "url.https://mirror.example/.insteadOf", "https://example.invalid/");
    // A URL named directly has no git answer to compare with, so it goes first.
    expect(await guard([REMOTE_URL, "main"])).toMatch(/insteadOf rule in the local git config/);
    expect(await guard(["origin", "main"])).toMatch(/insteadOf rule in the local git config/);
  });

  it("pushInsteadOf comes before insteadOf, however long", async () => {
    user("global", "url.https://mirror.example/.pushInsteadOf", "https://example.");
    repo("url.https://evil.example/.insteadOf", "https://example.invalid/acme/");
    expect(await guard(["origin", "main"])).toEqual(["https://mirror.example/invalid/acme/app.git"]);
    expect(await guard([REMOTE_URL, "main"])).toEqual(["https://mirror.example/invalid/acme/app.git"]);
    writeFileSync(globalConfig, "");
    git(work, "config", "--unset-all", "url.https://evil.example/.insteadOf");
    user("global", "url.https://mirror.example/.insteadOf", "https://example.invalid/");
    repo("url.https://evil.example/.pushInsteadOf", "https://example.");
    expect(await guard(["origin", "main"])).toMatch(/pushInsteadOf rule in the local git config/);
  });

  it("an explicit pushurl goes through insteadOf only", async () => {
    git(work, "remote", "set-url", "--push", "origin", "https://example.invalid/acme/push.git");
    repo("url.https://evil.example/.pushInsteadOf", "https://example.invalid/");
    expect(await guard(["origin", "main"])).toEqual(["https://example.invalid/acme/push.git"]);
    repo("url.https://evil.example/.insteadOf", "https://example.invalid/");
    expect(await guard(["origin", "main"])).toMatch(/insteadOf rule in the local git config/);
  });

  it("a remote with several URLs is pushed only through those a pushInsteadOf matches", async () => {
    git(work, "remote", "set-url", "--add", "origin", "https://other.example/acme/app.git");
    user("global", "url.https://mirror.example/.pushInsteadOf", "https://example.invalid/");
    repo("url.https://evil.example/.insteadOf", "https://other.example/");
    expect(await guard(["origin", "main"])).toEqual(["https://mirror.example/acme/app.git"]);
  });
});

describe("a refusal never shows a URL's user info, which can carry a token", () => {
  it("from a rule's base, a rewritten URL, or a URL git reports", async () => {
    repo("url.https://x-access-token:ghp_secret1@evil.example/.insteadOf", "https://example.invalid/");
    const fromBase = await guard(["origin", "main"]);
    expect(fromBase).toMatch(/insteadOf rule in the local git config/);
    expect(fromBase).not.toContain("ghp_secret1");

    git(work, "config", "--remove-section", "url.https://x-access-token:ghp_secret1@evil.example/");
    user("global", "url.file://x-access-token:ghp_secret2@localhost/srv/.insteadOf", "https://example.invalid/");
    const rewritten = await guard(["origin", "main"]);
    expect(rewritten).toMatch(/goes to file:\/\/localhost\/srv\/acme\/app\.git, which is not an https\/ssh remote/);
    expect(rewritten).not.toContain("ghp_secret2");

    // A remote git still reads from a legacy .git/remotes file has no
    // remote.* keys, so git's answer and the configuration's disagree.
    mkdirSync(join(work, ".git", "remotes"));
    writeFileSync(join(work, ".git", "remotes", "legacy"), "URL: https://x-access-token:ghp_secret3@example.invalid/acme/app.git\n");
    const reported = await guard(["legacy", "main"]);
    expect(reported).toMatch(/not run before approval$/);
    expect(reported).not.toContain("ghp_secret3");
  });
});

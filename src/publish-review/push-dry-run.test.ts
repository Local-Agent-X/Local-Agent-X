/**
 * The pre-approval push dry run runs on the host, in the agent's repository, so
 * whatever that repository's config can make git start, or wherever it can
 * point the push, is refused or overridden before git connects. Remotes here
 * are a bare repository on disk, unreachable network URLs, and a local HTTP
 * server; GIT_ALLOW_PROTOCOL (test-env.ts) is widened only inside the tests
 * that need ssh or http to be attempted. The user's system and global git
 * config are files of each test's own (GIT_CONFIG_SYSTEM / GIT_CONFIG_GLOBAL),
 * so no dry run here reaches the developer's real credential helpers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const guard = vi.hoisted(() => ({ bypass: false }));
vi.mock("./push-transport-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./push-transport-guard.js")>();
  return {
    ...actual,
    refusePushTransport: (cwd: string, args: string[]) => (guard.bypass ? Promise.resolve(null) : actual.refusePushTransport(cwd, args)),
  };
});

// The GitHub integration's token as the user's setup resolves it
// (github-token.test.ts covers that resolution).
const integration = vi.hoisted(() => ({ token: null as { name: string; value: string } | null }));
vi.mock("./github-token.js", () => ({ githubIntegrationToken: () => integration.token }));

// Every git the review starts, with what it was given and what it printed.
const exec = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; env?: Record<string, string>; stdout: string; stderr: string }> }));
vi.mock("./git-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-exec.js")>();
  return {
    ...actual,
    runGit: async (...[cwd, args, opts]: Parameters<typeof actual.runGit>) => {
      const r = await actual.runGit(cwd, args, opts);
      exec.calls.push({ args, env: opts?.env, stdout: r.stdout, stderr: r.stderr });
      return r;
    },
  };
});

import { dryRunArgv, passThroughArgs, pushDryRun, refusePushInvocation, userCredentialHelpers, type PushInvocation } from "./push-dry-run.js";
import { runGit } from "./git-exec.js";
import { isNetworkTransport } from "./push-transport-guard.js";
import { TOKEN_ENV, TOKEN_HELPER } from "../sync/git-auth.js";

const NETWORK_URL = "https://example.invalid/acme/app.git";
let root: string;
let remote: string;
let work: string;
let systemConfig: string;
let globalConfig: string;
const savedUserConfig = { system: process.env.GIT_CONFIG_SYSTEM, global: process.env.GIT_CONFIG_GLOBAL };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const slashes = (p: string): string => p.replace(/\\/g, "/");

async function refusal(args: string[], invocation: PushInvocation = {}): Promise<string> {
  const r = await pushDryRun(work, args, invocation);
  return r.ok ? "(ran)" : r.reason;
}

/** Runs `body` with these env vars set (undefined deletes), then restores them. */
async function withEnv(vars: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await body(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** An HTTP remote that asks for credentials and records the first `user:password` to arrive. */
async function authServer(): Promise<{ origin: string; url: string; credentials: () => string | null; close: () => Promise<void> }> {
  let credentials: string | null = null;
  const server = createServer((req, res) => {
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (basic) credentials ??= Buffer.from(basic, "base64").toString("utf8");
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="t"' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: `${origin}/acme/app.git`,
    credentials: () => credentials,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Adds `key = value` to the user's system or global config file of this test. */
function userConfig(scope: "system" | "global", key: string, value: string): void {
  git(root, "config", "-f", scope === "system" ? systemConfig : globalConfig, "--add", key, value);
}

/** A credential helper that leaves `marker` when git asks it anything, and offers `password`. */
function markerHelper(marker: string, password = "leaked"): string {
  return `!touch '${slashes(join(root, marker))}'; echo username=agent; echo password=${password}; :`;
}

/** A pre-push hook in the work repository that leaves a marker when it runs. */
function prePushHook(): string {
  const marker = join(root, "pre-push-ran");
  const hook = join(work, ".git", "hooks", "pre-push");
  writeFileSync(hook, `#!/bin/sh\ntouch '${slashes(marker)}'\n`);
  chmodSync(hook, 0o755);
  return marker;
}

/** A submodule holding a commit its remote lacks, so a recursing push pushes
 *  it, and whose remote names a receive-pack program that leaves a marker. */
function unpushedSubmodule(): string {
  const marker = join(root, "submodule-receive-pack-ran");
  const seed = join(root, "sub-seed");
  git(root, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "s.txt"), "s\n");
  git(seed, "add", "s.txt");
  git(seed, "commit", "-q", "-m", "s");
  git(work, "submodule", "add", "-q", slashes(seed), "sub");
  git(work, "commit", "-q", "-m", "add sub");
  const sub = join(work, "sub");
  writeFileSync(join(sub, "t.txt"), "t\n");
  git(sub, "add", "t.txt");
  git(sub, "commit", "-q", "-m", "t");
  git(sub, "config", "remote.origin.receivepack", `touch '${slashes(marker)}'; git-receive-pack`);
  git(work, "add", "sub");
  git(work, "commit", "-q", "-m", "bump sub");
  return marker;
}

beforeEach(() => {
  guard.bypass = false;
  integration.token = null;
  exec.calls.length = 0;
  root = mkdtempSync(join(tmpdir(), "lax-push-dry-run-"));
  systemConfig = join(root, "system.gitconfig");
  globalConfig = join(root, "global.gitconfig");
  writeFileSync(systemConfig, "");
  writeFileSync(globalConfig, "");
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  work = join(root, "work");
  git(root, "init", "-q", "-b", "main", work);
  writeFileSync(join(work, "README.md"), "# app\n");
  git(work, "add", "README.md");
  git(work, "commit", "-q", "-m", "initial");
  git(work, "remote", "add", "origin", remote);
});

afterEach(() => {
  for (const [name, value] of [["GIT_CONFIG_SYSTEM", savedUserConfig.system], ["GIT_CONFIG_GLOBAL", savedUserConfig.global]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("isNetworkTransport", () => {
  it("passes https, http, ssh and scp-like addresses; refuses paths, file://, git:// and helpers", () => {
    for (const url of [NETWORK_URL, "http://h/r.git", "ssh://git@h/r.git", "git@github.com:acme/app.git"]) {
      expect(isNetworkTransport(url)).toBe(true);
    }
    for (const url of ["/srv/r.git", "../r.git", "C:\\r.git", "C:/r.git", "\\\\server\\share\\r.git", "file:///srv/r.git", "git://h/r.git", "ext::sh -c x", "fd::3", "foo::bar", "FILE://x", "-", ""]) {
      expect(isNetworkTransport(url)).toBe(false);
    }
  });
});

describe("pushDryRun refuses a destination that is not a network remote at its configured URL", () => {
  it("a remote that is a path on this machine, named or by default", async () => {
    expect(await refusal([])).toMatch(/not an https\/ssh remote/);
    expect(await refusal(["origin", "main"])).toMatch(/not an https\/ssh remote/);
  });

  it("a file:// URL or a remote-helper address named on the command line", async () => {
    expect(await refusal([`file://${slashes(remote)}`, "main"])).toMatch(/not an https\/ssh remote/);
    expect(await refusal(["foo::bar", "main"])).toMatch(/not an https\/ssh remote/);
  });

  it("a push URL that url.*.pushInsteadOf or insteadOf redirects", async () => {
    git(work, "remote", "set-url", "origin", NETWORK_URL);
    git(work, "config", `url.${slashes(remote)}.pushInsteadOf`, NETWORK_URL);
    expect(await refusal(["origin", "main"])).toMatch(/insteadOf/i);
    expect(await refusal([NETWORK_URL, "main"])).toMatch(/insteadOf/i);
    git(work, "config", "--unset", `url.${slashes(remote)}.pushInsteadOf`);
    git(work, "config", "url.https://elsewhere.invalid/.insteadOf", "https://example.invalid/");
    expect(await refusal(["origin", "main"])).toMatch(/insteadOf/i);
    expect(await refusal([NETWORK_URL, "main"])).toMatch(/insteadOf/i);
  });

  it("a remote that names a helper or receive-pack program", async () => {
    git(work, "remote", "set-url", "origin", NETWORK_URL);
    git(work, "config", "remote.origin.vcs", "evil");
    expect(await refusal(["origin", "main"])).toMatch(/remote\.origin\.vcs/);
    git(work, "config", "--unset", "remote.origin.vcs");
    git(work, "config", "remote.origin.receivepack", "touch pwned; git-receive-pack");
    expect(await refusal(["origin", "main"])).toMatch(/remote\.origin\.receivepack/);
  });

  it("finds the repository behind -o values, a short-option cluster and an abbreviated --repo", async () => {
    git(work, "remote", "set-url", "origin", NETWORK_URL);
    // An operand wins over --repo in git, so the --repo cases name none.
    for (const args of [["-fo", "origin", remote, "main"], ["--push-option", "origin", remote, "main"], [`--rep=${remote}`], ["--rep", remote]]) {
      expect(await refusal(args)).toMatch(/not an https\/ssh remote/);
    }
  });

  it("the destination git picks when the push names none", async () => {
    git(work, "remote", "set-url", "origin", NETWORK_URL);
    git(work, "config", "branch.main.pushRemote", remote);
    expect(await refusal([])).toMatch(/not an https\/ssh remote/);
  });

  it("an abbreviated --receive-pack", async () => {
    expect(await refusal(["--rece=touch pwned", "origin", "main"])).toMatch(/receive-pack/);
  });

  it("lets a network remote at its configured URL, or one named directly, through to git", async () => {
    git(work, "remote", "set-url", "origin", NETWORK_URL);
    expect(await refusal(["origin", "main"])).toMatch(/dry-run failed: .*transport 'https' not allowed/);
    expect(await refusal([NETWORK_URL, "main"])).toMatch(/dry-run failed: .*transport 'https' not allowed/);
  });
});

describe("pushDryRun refuses a push whose own git options or environment it would not reproduce", () => {
  const c = (value: string): PushInvocation => ({ gitOptions: [{ name: "-c", value }] });

  it("each option or variable that changes the URL, the transport, the repository or what runs", () => {
    const refused: Array<[PushInvocation, RegExp]> = [
      [c("url.https://evil.invalid/.pushInsteadOf=https://example.invalid/"), /git config url\.\*\.pushinsteadof \(-c\)/],
      [c("url.https://evil.invalid/.insteadOf=https://example.invalid/"), /url\.\*\.insteadof \(-c\)/],
      [c("remote.origin.url=https://evil.invalid/r.git"), /remote\.\*\.url/],
      [c("remote.origin.pushurl=https://evil.invalid/r.git"), /remote\.\*\.pushurl/],
      [c("core.sshCommand=touch pwned"), /core\.sshcommand/],
      [c("credential.helper=!touch pwned"), /credential\.helper/],
      [c("core.hooksPath=hooks"), /core\.hookspath/],
      [c("include.path=evil.cfg"), /include\.path/],
      [c("push.default=matching"), /push\.default/],
      [{ gitOptions: [{ name: "--config-env", value: "core.sshCommand=EVIL" }] }, /core\.sshcommand \(--config-env\)/],
      [{ gitOptions: [{ name: "--git-dir", value: "../other/.git" }] }, /gives git --git-dir before push/],
      [{ gitOptions: [{ name: "--work-tree", value: "../other" }] }, /--work-tree/],
      [{ gitOptions: [{ name: "--bare" }] }, /--bare/],
      [{ gitOptions: [{ name: "--exec-path", value: "/evil" }] }, /--exec-path/],
      [{ gitOptions: [{ name: "-C", value: "a" }, { name: "-C", value: "b" }] }, /-C more than once/],
      [{ gitEnv: ["GIT_SSH_COMMAND"] }, /sets GIT_SSH_COMMAND in the push's environment/],
      [{ gitEnv: ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] }, /GIT_CONFIG_COUNT/],
      [{ gitEnv: ["GIT_DIR"] }, /GIT_DIR/],
      [{ gitEnv: ["PATH"] }, /PATH/],
      [{ gitEnv: ["HOME"] }, /HOME/],
      [{ gitEnv: ["LANG", "GIT_SSH"] }, /sets GIT_SSH in/],
    ];
    for (const [invocation, why] of refused) {
      const reason = refusePushInvocation(invocation) ?? "(not refused)";
      expect(reason, JSON.stringify(invocation)).toMatch(why);
      expect(reason).toMatch(/not run before approval$/);
    }
  });

  it("never repeats a URL from the config key, which can carry a token", () => {
    const reason = refusePushInvocation(c("url.https://x-access-token:ghp_secret@github.com/.insteadOf=https://github.com/"));
    expect(reason).toMatch(/url\.\*\.insteadof/);
    expect(reason).not.toContain("ghp_secret");
  });

  it("lets through what changes none of that: one -C, user/color/advice config, the pager, the locale", () => {
    expect(refusePushInvocation({
      gitOptions: [
        { name: "-C", value: "sub" }, { name: "-c", value: "user.name=x" }, { name: "-c", value: "User.Email=x@example.com" },
        { name: "-c", value: "color.ui=never" }, { name: "--config-env", value: "advice.pushUpdateRejected=V" }, { name: "--no-pager" },
      ],
      gitEnv: ["LANG", "LC_ALL", "GIT_TERMINAL_PROMPT"],
    })).toBeNull();
  });

  it("refuses before the guard or git runs: the dry run would review the push to the URL named, not where it goes", async () => {
    guard.bypass = true;
    const evil = join(root, "evil.git");
    git(root, "init", "-q", "--bare", "-b", "main", evil);
    expect(await refusal([slashes(remote), "main"], c(`url.${slashes(evil)}.pushInsteadOf=${slashes(remote)}`))).toMatch(/pushinsteadof/);
    expect(await refusal(["origin", "main"], { gitEnv: ["GIT_SSH_COMMAND"] })).toMatch(/GIT_SSH_COMMAND/);
    expect(await refusal(["origin", "main"], { gitOptions: [{ name: "-C", value: "." }, { name: "-c", value: "user.name=x" }], gitEnv: ["LANG"] })).toBe("(ran)");
  }, 60_000);
});

// git reads an unambiguous abbreviation, a negation and a negated negation of
// a long option as that option, and keeps the last value it is given. These
// push to the bare repository on disk (the transport guard stands aside), so
// a push that stopped being a dry run would land.
describe("pushDryRun cannot be argued out of being a dry run", () => {
  it("drops every spelling of an option the dry run sets itself, and nothing else", () => {
    const stripped = [
      "--verify", "--veri", "--no-verify", "--no-no-verify", "--no-no-veri",
      "--recurse-submodules=on-demand", "--recu=on-demand", "--recurse=only", "--no-recurse-submodules", "--no-recu",
      "--dry-run", "--dry", "--no-dry-run", "--no-dr", "-n", "--porcelain", "--no-porc",
      "--quiet", "--qui", "-q", "--verbose", "--verb", "-v", "--progress", "--no-prog", "--set-upstream", "--set-up", "-u",
    ];
    expect(passThroughArgs([...stripped, "origin", "main"])).toEqual(["origin", "main"]);
    const kept = ["--force", "--force-with-lease", "--tags", "--no-thin", "--atomic", "--push-option=--verify", "-o", "x", "origin", "main"];
    expect(passThroughArgs(kept)).toEqual(kept);
  });

  it("never really pushes, however --dry-run is negated", async () => {
    guard.bypass = true;
    for (const form of ["--no-dr", "--no-dry-run"]) {
      expect(await pushDryRun(work, [form, "origin", "main"], {})).toEqual({
        ok: true, refs: [expect.objectContaining({ remoteRef: "refs/heads/main", status: "new" })],
      });
    }
    expect(git(remote, "for-each-ref")).toBe("");
  }, 60_000);

  it("runs no pre-push hook for an abbreviated or doubly negated --no-verify", async () => {
    guard.bypass = true;
    const marker = prePushHook();
    for (const form of ["--veri", "--no-no-verify"]) {
      expect((await pushDryRun(work, [form, "origin", "main"], {})).ok).toBe(true);
    }
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("runs no hook even when the arguments that reach git turn verification back on", async () => {
    const marker = prePushHook();
    const r = await runGit(work, dryRunArgv(["--verify", "origin", "main"], []));
    expect(r.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("never recurses into a submodule, whose remote config would start a program", async () => {
    guard.bypass = true;
    const marker = unpushedSubmodule();
    for (const form of ["--recu=on-demand", "--recurse=only"]) {
      expect((await pushDryRun(work, [form, "origin", "main"], {})).ok).toBe(true);
    }
    expect(existsSync(marker)).toBe(false);
  }, 60_000);
});

describe("pushDryRun overrides repository config that would start a program", () => {
  it("never opens the local file transport, even with the guard out of the way", async () => {
    guard.bypass = true;
    await withEnv({ GIT_ALLOW_PROTOCOL: undefined }, async () => {
      expect(await refusal(["origin", "main"])).toMatch(/transport 'file' not allowed/);
    });
  });

  it("runs plain ssh, not the repository's core.sshCommand", async () => {
    const marker = join(root, "ssh-command-ran");
    git(work, "remote", "set-url", "origin", "ssh://127.0.0.1:1/acme/app.git");
    git(work, "config", "core.sshCommand", `touch '${slashes(marker)}'; false`);
    await withEnv({ GIT_ALLOW_PROTOCOL: "file:ssh" }, async () => {
      await pushDryRun(work, ["origin", "main"], {});
    });
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("never runs a credential helper the repository sets or includes, plain or for the remote's URL", async () => {
    const server = await authServer();
    const included = join(root, "repo-included.gitconfig");
    try {
      git(work, "remote", "set-url", "origin", server.url);
      git(work, "config", "credential.helper", markerHelper("repo-helper-ran"));
      git(work, "config", `credential.${server.origin}.helper`, markerHelper("repo-url-helper-ran"));
      git(root, "config", "-f", included, "credential.helper", markerHelper("repo-included-helper-ran"));
      git(work, "config", "include.path", slashes(included));
      await withEnv({ GIT_ALLOW_PROTOCOL: "file:http", GIT_ASKPASS: undefined, SSH_ASKPASS: undefined }, async () => {
        expect(await refusal(["origin", "main"])).toMatch(/dry-run failed/);
      });
      for (const marker of ["repo-helper-ran", "repo-url-helper-ran", "repo-included-helper-ran"]) {
        expect(existsSync(join(root, marker)), marker).toBe(false);
      }
      expect(server.credentials()).toBeNull();
    } finally {
      await server.close();
    }
  }, 60_000);

  it("runs no askpass program the repository names", async () => {
    const server = await authServer();
    const askpass = join(root, "askpass.sh");
    writeFileSync(askpass, "#!/bin/sh\necho leaked\n");
    chmodSync(askpass, 0o755);
    try {
      git(work, "remote", "set-url", "origin", server.url);
      git(work, "config", "core.askPass", slashes(askpass));
      await withEnv({ GIT_ALLOW_PROTOCOL: "file:http", GIT_ASKPASS: undefined, SSH_ASKPASS: undefined }, async () => {
        await pushDryRun(work, ["origin", "main"], {});
      });
      expect(server.credentials()).toBeNull();
    } finally {
      await server.close();
    }
  }, 60_000);
});

// An HTTPS remote answers a push dry run only to a signed-in client, so the
// dry run is given the user's own helpers. An HTTPS remote cannot be reached
// offline: helper selection is checked through git credential fill, which asks
// the helpers exactly as a push does, and the push itself against a local HTTP
// remote.
describe("pushDryRun signs in with the user's own credential helpers, never the repository's", () => {
  async function lent() {
    const r = await userCredentialHelpers(work);
    if (!r.ok) throw new Error(r.reason);
    return r.helpers;
  }

  it("lends the system then global helpers, URL-scoped ones and their resets included, after clearing every helper", async () => {
    const gh = "!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential";
    userConfig("system", "credential.helper", "manager");
    userConfig("global", "credential.https://github.com.helper", "");
    userConfig("global", "credential.https://github.com.helper", gh);
    git(work, "config", "credential.helper", "!repo");
    git(work, "config", "credential.https://github.com.helper", "!repo-url");
    const argv = dryRunArgv(["origin", "main"], await lent());
    expect(argv.slice(argv.indexOf("credential.helper=") - 1, argv.indexOf("push"))).toEqual([
      "-c", "credential.helper=",
      "-c", "credential.helper=manager",
      "-c", "credential.https://github.com.helper=",
      "-c", `credential.https://github.com.helper=${gh}`,
    ]);
  });

  it("has git ask the user's helpers for an HTTPS host, as their config scopes them, and never the repository's", async () => {
    userConfig("system", "credential.helper", markerHelper("system-helper-ran", "from-system"));
    userConfig("global", "credential.https://github.com.helper", "");
    userConfig("global", "credential.https://github.com.helper", '!f() { echo username=me; echo "password=from global"; }; f');
    git(work, "config", "credential.helper", markerHelper("repo-helper-ran"));
    git(work, "config", "credential.https://github.com.helper", markerHelper("repo-url-helper-ran"));
    const argv = dryRunArgv([], await lent());
    const fill = (host: string) =>
      runGit(work, [...argv.slice(0, argv.indexOf("push")), "credential", "fill"], { input: `protocol=https\nhost=${host}\n\n` });
    expect((await fill("github.com")).stdout).toContain("password=from global\n");
    expect(existsSync(join(root, "system-helper-ran"))).toBe(false);
    expect((await fill("example.com")).stdout).toContain("password=from-system\n");
    expect(existsSync(join(root, "system-helper-ran"))).toBe(true);
    expect(existsSync(join(root, "repo-helper-ran"))).toBe(false);
    expect(existsSync(join(root, "repo-url-helper-ran"))).toBe(false);
  }, 60_000);

  it("signs the push in with the user's helper, and git never asks the repository's even to forget a rejected password", async () => {
    const server = await authServer();
    try {
      git(work, "remote", "set-url", "origin", server.url);
      userConfig("global", `credential.${server.origin}.helper`, "!f() { echo username=me; echo password=from-global; }; f");
      git(work, "config", "credential.helper", markerHelper("repo-helper-ran"));
      await withEnv({ GIT_ALLOW_PROTOCOL: "file:http", GIT_ASKPASS: undefined, SSH_ASKPASS: undefined }, async () => {
        expect(await refusal(["origin", "main"])).toMatch(/dry-run failed/);
      });
      expect(server.credentials()).toBe("me:from-global");
      expect(existsSync(join(root, "repo-helper-ran"))).toBe(false);
    } finally {
      await server.close();
    }
  }, 60_000);
});

// A user who has not signed git in, but connected the GitHub integration, gets
// a dry run of a GitHub push signed in with that token. GIT_ALLOW_PROTOCOL
// keeps git off github.com here, so which host git would hand the token to is
// asked through git credential fill, with the argv and environment the dry
// run was given.
describe("pushDryRun signs a GitHub push in with the GitHub integration's token when the user has no helper", () => {
  const TOKEN = "github_pat_11TESTVALUE0never_in_argv_or_output";
  const GITHUB_URL = "https://github.com/acme/app.git";
  const SCOPED_HELPER = `credential.https://github.com.helper=${TOKEN_HELPER}`;

  function dryRunCall(): (typeof exec.calls)[number] {
    const call = exec.calls.find((c) => c.args.includes("--dry-run"));
    if (!call) throw new Error("git push --dry-run never ran");
    return call;
  }
  const lent = (): boolean => dryRunCall().env?.[TOKEN_ENV] === TOKEN && dryRunCall().args.includes(SCOPED_HELPER);

  beforeEach(() => {
    integration.token = { name: "GITHUB_TOKEN", value: TOKEN };
    git(work, "remote", "set-url", "origin", GITHUB_URL);
  });

  it("hands it to git in the environment, as the one helper, scoped to https://github.com", async () => {
    expect(await refusal(["origin", "main"])).toMatch(/dry-run failed: .*transport 'https' not allowed/);
    const { args, env } = dryRunCall();
    expect(env).toEqual({ [TOKEN_ENV]: TOKEN });
    expect(args.slice(args.indexOf("credential.helper=") - 1, args.indexOf("push"))).toEqual(["-c", "credential.helper=", "-c", SCOPED_HELPER]);
  });

  it("never puts it in any git's argv, stdout or stderr, or in the result, with git tracing on or off", async () => {
    for (const trace of [{}, { GIT_TRACE: "1", GIT_TRACE_CURL: "1", GIT_TRACE_REDACT: "0" }]) {
      exec.calls.length = 0;
      await withEnv(trace, async () => {
        expect(JSON.stringify(await pushDryRun(work, ["origin", "main"], {}))).not.toContain(TOKEN);
      });
      for (const call of exec.calls) {
        expect(call.args.join("\n")).not.toContain(TOKEN);
        expect(call.stdout + call.stderr).not.toContain(TOKEN);
      }
      expect(lent()).toBe(true);
    }
  }, 60_000);

  it("is what git hands https://github.com, and never another host, an http URL or a look-alike", async () => {
    await refusal(["origin", "main"]);
    const { args, env } = dryRunCall();
    const fill = (url: string) => runGit(work, [...args.slice(0, args.indexOf("push")), "credential", "fill"], { input: `url=${url}\n\n`, env });
    await withEnv({ GIT_ASKPASS: undefined, SSH_ASKPASS: undefined }, async () => {
      expect((await fill(GITHUB_URL)).stdout).toContain(`password=${TOKEN}\n`);
      for (const url of ["https://gitlab.com/acme/app.git", "http://github.com/acme/app.git", "https://github.com.evil.example/acme/app.git", "https://api.github.com/repos"]) {
        expect((await fill(url)).stdout, url).not.toContain(TOKEN);
      }
    });
  }, 60_000);

  it("lends nothing when the user has a credential helper of their own, for whichever host", async () => {
    userConfig("global", "credential.https://gitlab.com.helper", "!f() { :; }; f");
    await refusal(["origin", "main"]);
    expect(dryRunCall().env).toBeUndefined();
    expect(dryRunCall().args.join("\n")).not.toContain(TOKEN_HELPER);
  });

  it("lends it when the user's config only resets helpers", async () => {
    userConfig("global", "credential.helper", "");
    await refusal(["origin", "main"]);
    expect(lent()).toBe(true);
  });

  it("lends nothing for a push that does not go to github.com over HTTPS", async () => {
    for (const url of ["https://gitlab.com/acme/app.git", "http://github.com/acme/app.git", "git@github.com:acme/app.git", "ssh://git@github.com/acme/app.git", "https://github.com.evil.example/acme/app.git"]) {
      exec.calls.length = 0;
      git(work, "remote", "set-url", "origin", url);
      await refusal(["origin", "main"]);
      expect(dryRunCall().env, url).toBeUndefined();
      expect(dryRunCall().args.join("\n"), url).not.toContain(TOKEN_HELPER);
    }
  });

  it("follows the user's own url rewrites, to github.com and away from it", async () => {
    userConfig("global", "url.https://github.com/.insteadOf", "gh:");
    await refusal(["gh:acme/app.git", "main"]);
    expect(lent()).toBe(true);
    exec.calls.length = 0;
    userConfig("global", "url.https://mirror.example/.pushInsteadOf", "https://github.com/");
    await refusal(["origin", "main"]);
    expect(dryRunCall().env).toBeUndefined();
  });

  it("lends nothing when the GitHub integration is not connected", async () => {
    integration.token = null;
    await refusal(["origin", "main"]);
    expect(dryRunCall().env).toBeUndefined();
    expect(dryRunCall().args.join("\n")).not.toContain(TOKEN_HELPER);
  });
});

describe("pushDryRun refuses a repository whose config would shape the signed-in connection", () => {
  const reason = async (): Promise<string> => {
    const r = await userCredentialHelpers(work);
    return r.ok ? "(lent)" : r.reason;
  };

  it("each setting that moves, unprotects or reconfigures it, or that the user's helper would read", async () => {
    const shaped: Array<[string, string, RegExp]> = [
      ["http.sslVerify", "false", /sets http\.sslverify,/],
      ["http.https://github.com/.sslVerify", "false", /sets http\.\*\.sslverify,/],
      ["http.proxy", "http://127.0.0.1:9", /sets http\.proxy,/],
      ["http.sslCAInfo", "ca.pem", /sets http\.sslcainfo,/],
      ["http.curloptResolve", "github.com:443:127.0.0.1", /sets http\.curloptresolve,/],
      ["remote.origin.proxy", "http://127.0.0.1:9", /sets remote\.\*\.proxy,/],
      ["remote.origin.proxyAuthMethod", "basic", /sets remote\.\*\.proxyauthmethod,/],
      ["credential.username", "other", /sets credential\.username,/],
      ["credential.https://github.com.trace", "C:/t.log", /sets credential\.\*\.trace,/],
      ["credential.traceSecrets", "true", /sets credential\.tracesecrets,/],
    ];
    for (const [key, value, why] of shaped) {
      git(work, "config", key, value);
      const r = await reason();
      expect(r, key).toMatch(why);
      expect(r).toMatch(/^the repository's git config \(local\) .*not run before approval$/);
      git(work, "config", "--unset-all", key);
    }
  });

  it("whether the repository sets it or includes a file that does", async () => {
    const included = join(root, "repo-included.gitconfig");
    git(root, "config", "-f", included, "http.sslVerify", "false");
    git(work, "config", "includeIf.gitdir:**.path", slashes(included));
    expect(await reason()).toMatch(/\(local\) sets http\.sslverify,/);
  });

  it("never repeats a URL from the key, which can carry a token", async () => {
    git(work, "config", "http.https://x-access-token:ghp_secret@github.com/.proxy", "http://127.0.0.1:9");
    const r = await reason();
    expect(r).toMatch(/http\.\*\.proxy/);
    expect(r).not.toContain("ghp_secret");
  });

  it("refuses before git connects", async () => {
    git(work, "remote", "set-url", "origin", NETWORK_URL);
    git(work, "config", "http.sslVerify", "false");
    expect(await refusal(["origin", "main"])).toMatch(/^the repository's git config \(local\) sets http\.sslverify,/);
  });

  it("refuses when the config is too long to read in full, as the repository's part is what gets cut", async () => {
    appendFileSync(join(work, ".git", "config"), `[http]\n${"\tpostBuffer = 1\n".repeat(12_000)}\tsslVerify = false\n`);
    expect(await reason()).toMatch(/could not read the config .*larger than the review reads.*not run before approval$/);
  });

  it("lets through the user's own settings, the repository's helpers it clears, a buffer size, timeouts and the HTTP version", async () => {
    userConfig("global", "http.sslVerify", "false");
    userConfig("global", "http.https://github.com/.proxy", "http://proxy.example:3128");
    userConfig("system", "credential.username", "me");
    userConfig("global", "remote.origin.proxy", "http://proxy.example:3128");
    git(work, "remote", "set-url", "origin", NETWORK_URL);
    for (const [key, value] of [["credential.helper", "!repo"], ["http.postBuffer", "524288000"], ["http.lowSpeedLimit", "1000"], ["http.lowSpeedTime", "60"], ["http.version", "HTTP/1.1"]]) {
      git(work, "config", key, value);
    }
    expect(await reason()).toBe("(lent)");
    expect(await refusal(["origin", "main"])).toMatch(/dry-run failed: .*transport 'https' not allowed/);
  });
});

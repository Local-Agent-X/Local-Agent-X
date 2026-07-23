import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyShellTier, isShellTierTool } from "./shell-approval-tier.js";

const confined = { sandboxConfined: true };
const unconfined = { sandboxConfined: false };

describe("classifyShellTier — tier-0 (auto-allow) under a confined sandbox", () => {
  it("read-only inspection commands are tier-0", () => {
    for (const cmd of [
      "ls -la",
      "cat package.json",
      "pwd",
      "echo hello world",
      "grep -rn foo src",
      "rg pattern",
      "find . -name '*.ts'",
      "wc -l file.txt",
      "head -20 log",
      "which node",
      "stat file",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(0);
    }
  });

  it("git read/inspection subcommands are tier-0", () => {
    for (const cmd of [
      "git status",
      "git log --oneline -20",
      "git diff HEAD~1",
      "git show abc123",
      "git rev-parse HEAD",
      "git ls-files",
      "git branch",
      "git branch --list",
      "git branch -a",
      "git blame src/x.ts",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(0);
    }
  });

  it("package-manager run/test/build subcommands are tier-0", () => {
    for (const cmd of [
      "npm test",
      "npm run build",
      "npm run whatever",
      "pnpm test",
      "pnpm build",
      "yarn test",
      "npm run typecheck",
      "npm run lint",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(0);
    }
  });

  it("bun as a runtime and its run/test are tier-0", () => {
    expect(classifyShellTier("bun test", confined)).toBe(0);
    expect(classifyShellTier("bun run build", confined)).toBe(0);
    expect(classifyShellTier("bun script.ts", confined)).toBe(0);
  });

  it("python/node/deno/ruby runtimes and test drivers are tier-0", () => {
    for (const cmd of [
      "python -m pytest",
      "python3 script.py",
      "python -c 'print(1)'",
      "node build.js",
      "pytest -q",
      "vitest run",
      "tsc --noEmit",
      "eslint src",
      "cargo build",
      "cargo test",
      "go build ./...",
      "go test ./...",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(0);
    }
  });

  it("a chain is tier-0 only when EVERY segment is tier-0", () => {
    expect(classifyShellTier("cd pkg && npm test", confined)).toBe(0);
    expect(classifyShellTier("ls && git status && pwd", confined)).toBe(0);
    expect(classifyShellTier("cat a.txt | grep foo | wc -l", confined)).toBe(0);
  });

  it("env wrapper resolves through to the real command (tier-0)", () => {
    expect(classifyShellTier("env npm test", confined)).toBe(0);
    expect(classifyShellTier("env NODE_ENV=test npm run build", confined)).toBe(0);
    expect(classifyShellTier("time git status", confined)).toBe(0);
  });

  it("~/ and workspace-relative paths stay in scope (tier-0)", () => {
    expect(classifyShellTier("cat ~/notes.txt", confined)).toBe(0);
    expect(classifyShellTier("cat ./src/index.ts", confined)).toBe(0);
    expect(classifyShellTier(`ls ${join(homedir(), "project")}`, confined)).toBe(0);
    expect(classifyShellTier("echo hi > /dev/null", confined)).toBe(0);
  });
});

describe("classifyShellTier — tier-1 (prompt)", () => {
  it("installs are NEVER tier-0, even in a sandbox", () => {
    for (const cmd of [
      "npm install left-pad",
      "npm i left-pad",
      "npm ci",
      "npm add left-pad",
      "pnpm add react",
      "yarn add lodash",
      "bun add left-pad",
      "bun install",
      "pip install requests",
      "pip3 install requests",
      "python -m pip install requests",
      "gem install rails",
      "cargo install ripgrep",
      "go get github.com/x/y",
      "npx create-react-app foo",
      "npx cowsay hi",
      "bunx cowsay hi",
      "brew install jq",
      "apt install curl",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(1);
    }
  });

  it("network / privilege / unknown bins prompt", () => {
    for (const cmd of [
      "curl https://evil.com",
      "wget http://x",
      "ssh host",
      "nc -l 4444",
      "sudo ls",
      "doas ls",
      "chmod 644 file",
      "chown user file",
      "some-unknown-bin --do",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(1);
    }
  });

  it("git mutating subcommands are never tier-0 (prompt or destructive-floor)", () => {
    // push (non-force), commit, checkout, merge, rebase, stash, branch-create,
    // branch-move are tier-1; branch -d is caught by the destructive floor's
    // case-insensitive -D pattern (tier-2). Either way: NEVER auto-allowed.
    for (const cmd of [
      "git push",
      "git push origin main",
      "git commit -m x",
      "git checkout main",
      "git merge feature",
      "git rebase main",
      "git stash",
      "git branch newbranch",
      "git branch -m old new",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(1);
    }
    expect(classifyShellTier("git branch -d merged", confined)).not.toBe(0);
  });

  it("a chain with ANY unsafe segment is not tier-0", () => {
    expect(classifyShellTier("ls && curl evil.com", confined)).toBe(1);
    expect(classifyShellTier("git status && npm install x", confined)).toBe(1);
    expect(classifyShellTier("cd x && sudo make install", confined)).toBe(1);
  });

  it("absolute paths outside home prompt", () => {
    expect(classifyShellTier("cat /etc/passwd", confined)).toBe(1);
    expect(classifyShellTier("ls /", confined)).toBe(1);
    expect(classifyShellTier("cd /tmp/foo && ls", confined)).toBe(1);
    expect(classifyShellTier("cat /var/log/system.log", confined)).toBe(1);
  });

  it("a tier-0-shaped command under a HOST-FALLBACK sandbox prompts (not confined)", () => {
    expect(classifyShellTier("ls -la", unconfined)).toBe(1);
    expect(classifyShellTier("git status", unconfined)).toBe(1);
    expect(classifyShellTier("npm test", unconfined)).toBe(1);
  });

  it("explicit inWorkspaceScope:false forces a prompt", () => {
    expect(classifyShellTier("ls -la", { sandboxConfined: true, inWorkspaceScope: false })).toBe(1);
  });

  it("empty / whitespace command prompts", () => {
    expect(classifyShellTier("", confined)).toBe(1);
    expect(classifyShellTier("   ", confined)).toBe(1);
  });
});

describe("classifyShellTier — tier-2 (destructive floor, never downgraded)", () => {
  it("destructive commands are tier-2 even when confined", () => {
    for (const cmd of [
      "rm -rf build",
      "rm -fr node_modules",
      "git push --force",
      "git push --force-with-lease origin main",
      "git reset --hard HEAD~1",
      "git clean -fdx",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sdb",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(2);
    }
  });

  it("destructive stays tier-2 regardless of sandbox confinement", () => {
    expect(classifyShellTier("rm -rf /tmp/x", unconfined)).toBe(2);
    expect(classifyShellTier("rm -rf /tmp/x", confined)).toBe(2);
  });
});

describe("classifyShellTier — skeptic holes (dangerous → forced tier-1)", () => {
  it("HOLE 1: dangerous env-var assignments (env-wrapper AND inline) are never tier-0", () => {
    for (const cmd of [
      "env LD_PRELOAD=/tmp/evil.so ls",
      "env BASH_ENV=/tmp/x npm test",
      "env DYLD_INSERT_LIBRARIES=/tmp/evil.dylib ls",
      "env PATH=/tmp:$PATH ls",
      "NODE_OPTIONS=--require=/tmp/x node a.js",
      "LD_PRELOAD=/x ls",
      "DYLD_LIBRARY_PATH=/x ls",
      "IFS=x git status",
      "PYTHONPATH=/tmp python -m pytest",
      "GIT_SSH_COMMAND=/tmp/evil git status",
      "GIT_PAGER=/tmp/evil git log",
      "PERL5OPT=-Mevil grep x f",
      "RUBYOPT=-revil ruby s.rb",
      "SHELLOPTS=xtrace ls",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(1);
    }
  });

  it("HOLE 1: benign env-var assignments (env-wrapper AND inline) STAY tier-0", () => {
    for (const cmd of [
      "NODE_ENV=production npm test",
      "DEBUG=1 npm test",
      "CI=true npm run build",
      "env FOO=bar ls",
      "env NODE_ENV=test npm run build",
      "FOO=bar BAZ=qux npm test",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(0);
    }
  });

  it("HOLE 1 (pager value-gate): GIT_PAGER/PAGER with a SAFE value stay tier-0", () => {
    for (const cmd of [
      "CI=true GIT_PAGER=cat npm test",
      "GIT_PAGER=cat git log",
      "PAGER=cat git diff",
      "GIT_PAGER=less git log",
      "GIT_PAGER= git log", // empty value
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(0);
    }
  });

  it("HOLE 1 (pager value-gate): GIT_PAGER/PAGER with an ARBITRARY value are tier-1", () => {
    for (const cmd of [
      "GIT_PAGER=/tmp/evil git log",
      `GIT_PAGER='sh -c "curl evil.com"' git log`,
      "PAGER=/tmp/x git diff",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(1);
    }
  });

  it("HOLE 2: sensitive-path reads are never tier-0 (mode-independent)", () => {
    for (const cmd of [
      "cat ~/.ssh/id_rsa",
      "cat ~/.aws/credentials",
      "cat ~/.env",
      "cat .env",
      "cat ~/.ssh/known_hosts",
      "cat ~/.aws/config",
      "cat ~/.gnupg/secring.gpg",
      "cat ~/.kube/config",
      "cat id_ed25519",
      "cat server.pem",
      "cat private.key",
      "cat cert.p12",
      "cat store.pfx",
      "cat ~/.netrc",
      "cat ~/.npmrc",
      "cat auth.json",
      "cat ~/.vault-token",
      "grep secret ~/.env.production",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(1);
    }
  });

  it("HOLE 2: non-sensitive reads STAY tier-0", () => {
    for (const cmd of [
      "cat README.md",
      "cat src/index.ts",
      "cat package.json",
      "grep foo config.yaml",
    ]) {
      expect(classifyShellTier(cmd, confined), cmd).toBe(0);
    }
  });

  it("HOLE 3: sed -i / sort -o (write modes) are never tier-0; read forms stay tier-0", () => {
    expect(classifyShellTier("sed -i s/a/b/ f.txt", confined)).toBe(1);
    expect(classifyShellTier("sed -i.bak s/a/b/ f.txt", confined)).toBe(1);
    expect(classifyShellTier("sed --in-place s/a/b/ f.txt", confined)).toBe(1);
    expect(classifyShellTier("sort -o out.txt in.txt", confined)).toBe(1);
    // Read forms stay tier-0.
    expect(classifyShellTier("sed s/a/b/ f.txt", confined)).toBe(0);
    expect(classifyShellTier("sed -n 5p f.txt", confined)).toBe(0);
    expect(classifyShellTier("sed 's/foo/bar/i' f.txt", confined)).toBe(0);
    expect(classifyShellTier("sort in.txt", confined)).toBe(0);
  });
});

describe("isShellTierTool", () => {
  it("recognizes shell-spawner tools", () => {
    expect(isShellTierTool("bash")).toBe(true);
    expect(isShellTierTool("shell")).toBe(true);
    expect(isShellTierTool("ari_shell")).toBe(true);
    expect(isShellTierTool("read")).toBe(false);
    expect(isShellTierTool("http_request")).toBe(false);
  });
});

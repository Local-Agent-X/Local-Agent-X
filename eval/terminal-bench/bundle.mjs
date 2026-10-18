#!/usr/bin/env node
// Builds the Linux bundle the Harbor agent (lax_agent.py) copies into every
// Terminal-Bench task container: the committed tree at HEAD, the built dist/
// (and the vendored kernel's dist/), production node_modules compiled for
// linux-x64, and a Node binary to run it all.
//
//   npx tsx eval/terminal-bench/bundle.mjs [--out <file.tgz>] [--image node:24-bullseye]
//
// Needs Docker. node_modules are installed inside a Debian bullseye container
// (glibc 2.31) so the native addons load on the Ubuntu 20.04+ / Debian 11+
// images most tasks use; a musl (Alpine) task image cannot run them.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDistMatchesSource } from "../op-outcomes/isolated.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const out = resolve(arg("out", join(homedir(), ".cache", "lax-terminal-bench", "lax-linux-x64.tgz")));
const image = arg("image", "node:24-bullseye");
const git = (...a) => execFileSync("git", ["-C", repoRoot, ...a], { encoding: "utf8" });

// The bundle is one commit's code: a dirty tree would ship edits no commit records.
const dirty = git("status", "--porcelain", "--untracked-files=no").trim();
if (dirty) {
  console.error(`refusing to bundle a dirty tree; commit or stash first:\n${dirty}`);
  process.exit(2);
}
assertDistMatchesSource(repoRoot);
const head = git("rev-parse", "HEAD").trim();

const stage = mkdtempSync(join(tmpdir(), "lax-tb-bundle-"));
try {
  const tarPath = join(stage, "head.tar");
  execFileSync("git", ["-C", repoRoot, "archive", "--format=tar", "-o", tarPath, "HEAD"]);
  const tree = join(stage, "lax");
  mkdirSync(tree);
  execFileSync("tar", ["-xf", tarPath, "-C", tree]);
  rmSync(tarPath);

  // Build output is gitignored: copy what the server loads at runtime.
  cpSync(join(repoRoot, "dist"), join(tree, "dist"), { recursive: true });
  const kernel = join(repoRoot, "packages", "arikernel");
  for (const pkg of readdirSync(kernel)) {
    const dist = join(kernel, pkg, "dist");
    if (existsSync(dist) && statSync(dist).isDirectory()) cpSync(dist, join(tree, "packages", "arikernel", pkg, "dist"), { recursive: true });
  }

  mkdirSync(dirname(out), { recursive: true });
  // --ignore-scripts skips the root postinstall (it builds the kernel and
  // installs git hooks, both done above or not wanted); `npm rebuild` then
  // runs only the dependencies' own install scripts, which fetch or compile
  // their Linux binaries.
  const script = [
    "set -euo pipefail",
    "cd /lax",
    "npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
    "npm rebuild --foreground-scripts",
    "mkdir -p .node/bin && cp \"$(command -v node)\" .node/bin/node",
    `tar -czf /out/${basename(out)} -C /lax .`,
  ].join(" && ");
  execFileSync("docker", ["run", "--rm", "-v", `${tree}:/lax`, "-v", `${dirname(out)}:/out`, image, "bash", "-c", script], { stdio: "inherit" });
  console.log(`bundle: ${out}\ncommit: ${head}\nimage: ${image}`);
} finally {
  rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

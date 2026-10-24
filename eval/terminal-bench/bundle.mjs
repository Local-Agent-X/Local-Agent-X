#!/usr/bin/env node
// Builds the Linux bundle the Harbor agent (lax_agent.py) copies into every
// Terminal-Bench task container: one commit's tree, compiled for Linux, with
// production node_modules and a Node binary to run it.
//
//   node eval/terminal-bench/bundle.mjs [--ref main] [--out <file.tgz>] [--image node:24-bullseye]
//
// Everything is built inside a container from `git archive <ref>`, so the
// bundle is exactly that commit's code: uncommitted edits, a stale dist/ or
// a Windows node_modules in the checkout never reach it. Debian bullseye
// (glibc 2.31) keeps the native addons loadable on the Ubuntu 20.04+ /
// Debian 11+ images most tasks use; a musl (Alpine) task image cannot run them.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const ref = arg("ref", "HEAD");
const out = resolve(arg("out", join(homedir(), ".cache", "lax-terminal-bench", "lax-linux-x64.tgz")));
const image = arg("image", "node:24-bullseye");
const commit = execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();

const stage = mkdtempSync(join(tmpdir(), "lax-tb-bundle-"));
try {
  execFileSync("git", ["-C", repoRoot, "archive", "--format=tar", "-o", join(stage, "src.tar"), commit]);
  mkdirSync(dirname(out), { recursive: true });
  // Built in the container's own filesystem, not on the bind mount: an npm
  // install over a Windows mount is many times slower.
  // --ignore-scripts skips the root postinstall (git hooks, a prebuilt-dist
  // step); the build steps it would trigger run explicitly below, and
  // `npm rebuild` then runs only the dependencies' own install scripts,
  // which fetch or compile their Linux binaries.
  const script = [
    "set -euo pipefail",
    "mkdir -p /lax && tar -xf /stage/src.tar -C /lax && cd /lax",
    "npm ci --ignore-scripts --no-audit --no-fund",
    "node scripts/build-ari.js",
    "npx tsc",
    "node scripts/copy-bundled-assets.mjs",
    `echo ${commit} > dist/.builtref`,
    "npm prune --omit=dev --ignore-scripts --no-audit --no-fund",
    "npm rebuild --foreground-scripts",
    // The browser tool's headless Chromium, and every shared library it links
    // that a task image may lack (nss, atk, gbm, ...). glibc and libstdc++ stay
    // the image's own: node needs them too, and two copies in one process
    // would clash. drive.mjs points the server at both. Without it the browser
    // tool failed in every task ("Executable doesn't exist at
    // /root/.cache/ms-playwright/...", mteb-leaderboard, 2026-10-24).
    "export PLAYWRIGHT_BROWSERS_PATH=/lax/.ms-playwright",
    // Bullseye's security suite left deb.debian.org (the files 404), so its
    // packages install from archive.debian.org, as apt_fallback.py does for
    // the agents' setup.
    "(node node_modules/playwright/cli.js install-deps chromium-headless-shell || (sed -i -E 's#^deb (https?://)(deb|security)\\.debian\\.org/debian-security#deb \\1archive.debian.org/debian-security#' /etc/apt/sources.list && apt-get update -qq && node node_modules/playwright/cli.js install-deps chromium-headless-shell))",
    "node node_modules/playwright/cli.js install chromium-headless-shell",
    "mkdir -p .ms-playwright/lib",
    "shell=$(ls .ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | head -1)",
    "ldd \"$shell\" | awk '/=> \//{print $3}' | grep -vE '/(libc|libm|libdl|libpthread|librt|libresolv|libstdc\+\+|libgcc_s|ld-linux[^/]*)\.so' | xargs -r -I{} cp -L {} .ms-playwright/lib/",
    "test -z \"$(LD_LIBRARY_PATH=/lax/.ms-playwright/lib ldd \"$shell\" | grep 'not found')\"",
    "mkdir -p .node/bin && cp \"$(command -v node)\" .node/bin/node",
    `tar -czf /out/${basename(out)} -C /lax .`,
  ].join(" && ");
  execFileSync("docker", ["run", "--rm", "-v", `${stage}:/stage:ro`, "-v", `${dirname(out)}:/out`, image, "bash", "-c", script], { stdio: "inherit" });
  console.log(`bundle: ${out}\ncommit: ${commit}\nimage: ${image}`);
} finally {
  rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

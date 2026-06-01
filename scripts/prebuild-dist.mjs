import { execSync } from "node:child_process";

// Build the compiled server (dist/) at install time so the desktop can boot
// via plain node instead of tsx — skips the per-file transpile cost on every
// cold start. Non-fatal: dist is an optimization. If the build fails (e.g. a
// WIP type error during a dev install) the desktop's freshness gate falls
// back to tsx-from-source, so a failed dist build must never block install.
try {
  execSync("tsc", { stdio: "inherit" });
} catch {
  console.warn("[prebuild-dist] tsc failed — desktop will boot via tsx until `npm run build` succeeds");
}

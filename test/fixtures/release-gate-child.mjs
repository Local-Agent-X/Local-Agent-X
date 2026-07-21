import { spawn } from "node:child_process";

const mode = process.argv[2];
process.stdout.write("release-gate-fixture:partial-output");
if (mode === "pass") process.exit(0);
if (mode === "vitest-skip") {
  process.stdout.write("\n Tests  9 passed | 2 skipped (11)\n");
  process.exit(0);
}
if (mode === "prerequisite") process.exit(2);
if (mode === "skip") process.exit(77);
if (mode === "fail") process.exit(9);
if (mode === "tree-timeout" || mode === "stubborn-tree-timeout") {
  const pidFile = process.argv[3];
  const ignoreTerm = mode === "stubborn-tree-timeout" ? "process.on('SIGTERM',()=>{});" : "";
  spawn(process.execPath, ["-e", `${ignoreTerm}require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`], {
    stdio: "ignore",
  });
  if (mode === "stubborn-tree-timeout") process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1_000);
} else if (mode === "timeout") setInterval(() => {}, 1_000);
else process.exit(3);

// CI generates the app manifest with `tsx -e "import … from
// './src/manifest-generator/index.ts'"` before any test runs, and tsx
// evaluates that as CommonJS. A module the generator imports that reaches an
// ESM-only package (@arikernel/* exports `import` only) cannot load there:
// every unit lane failed at "Generate test manifest" on 2026-10-02 because the
// summary imported a constant from a module that imports settings.ts and,
// through it, @arikernel/policy-engine. This loads the generator the same way,
// without writing the manifest.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

it("the manifest generator loads under tsx -e (CommonJS), as CI's Generate test manifest step runs it", () => {
  const run = spawnSync(process.execPath, [tsxCli, "-e", "import './src/manifest-generator/index.ts'"], {
    cwd: repo,
    encoding: "utf8",
    timeout: 90_000,
  });
  // Only the error line: tsx's stderr also dumps its own minified source, whose
  // source-map comment vitest would try to parse.
  const errorLine = run.stderr.split("\n").find((line) => /^\w*Error\b/.test(line.trim())) ?? `exit ${run.status}`;
  expect(errorLine).not.toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_REQUIRE_ESM|Cannot find module/);
  expect(run.status, errorLine).toBe(0);
}, 120_000);

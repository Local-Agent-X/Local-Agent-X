#!/usr/bin/env node
/**
 * Opt-in pre-commit block that runs the tool-discovery eval when prompt or
 * tool-routing files are staged. Run once per checkout:
 *   npm run eval:install-hook
 *
 * Installs as a guarded block (scripts/git-hook-block.mjs) so it coexists with
 * the generated-docs and audit blocks in the same hook.
 */
import { installHookBlock, hookScriptPath } from "./git-hook-block.mjs";

const result = installHookBlock({
  hook: "pre-commit",
  id: "lax-eval-gate",
  body: [
    "# Runs the tool-discovery eval when prompt or tool-routing files are staged.",
    "# Bypass: SKIP_EVAL_GATE=1 git commit ...",
    `node "${hookScriptPath("scripts/eval-gate.mjs")}" || exit $?`,
  ].join("\n"),
});

if (result.action === "skipped") {
  console.error(`[eval-gate] ${result.reason}`);
  process.exit(1);
}

console.log(`[eval-gate] ${result.action} in ${result.hookPath}`);
console.log("[eval-gate] The gate runs automatically when you commit changes to:");
console.log("  - config/system-prompt.md");
console.log("  - src/agent-request/tool-filter.ts");
console.log("  - src/agent-request/audience-tagger.ts");

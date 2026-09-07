#!/usr/bin/env node
/**
 * Opt-in pre-commit block that runs the local audit (scripts/precommit-audit.sh).
 *
 * Separate from install-git-hooks.mjs because the audit is a developer choice,
 * not something every clone should pay for. It installs as a guarded block so
 * it coexists with the generated-docs block instead of replacing the hook —
 * the previous shell version wrote the whole pre-commit file and silently
 * removed anything else in it.
 */
import { installHookBlock, hookScriptPath } from "./git-hook-block.mjs";

const result = installHookBlock({
  hook: "pre-commit",
  id: "lax-precommit-audit",
  body: [
    "# Runs the local pre-commit audit. Bypass: git commit --no-verify",
    `bash "${hookScriptPath("scripts/precommit-audit.sh")}" || exit $?`,
  ].join("\n"),
});

if (result.action === "skipped") {
  console.error(`[audit-hook] ${result.reason}`);
  process.exit(1);
}
console.log(`[audit-hook] ${result.action} in ${result.hookPath}`);

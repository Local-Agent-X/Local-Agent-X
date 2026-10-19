#!/usr/bin/env node
/**
 * Install the git hooks every checkout should have. Runs from postinstall, so
 * a clone gets them without a manual step; exits quietly for tarball installs
 * that have no .git.
 *
 * pre-commit  generated docs are regenerated and staged, so a commit that adds
 *             a source file cannot ship a stale docs/codebase-map.md — the
 *             defect class that made `npm run build` fail on the candidate the
 *             rolling updater compiles, blocking updates for every install.
 * commit-msg  a subject that cites the size rule ("under the 400-LOC gate")
 *             instead of naming the change is rejected (check-commit-subject.mjs).
 * pre-push    machine-generated "Agent selfedit-*" commits never leave the box.
 *
 * Convenience, not enforcement: hooks are per-machine and --no-verify skips
 * them. CI is the gate that decides what reaches users.
 */
import { installHookBlock, hookScriptPath } from "./git-hook-block.mjs";

const HOOKS = [
  {
    hook: "pre-commit",
    id: "lax-generated-docs",
    body: [
      "# Regenerates docs generated from source and stages them when the commit",
      "# touches code that can move them. Bypass: SKIP_GENERATED_DOCS=1 git commit",
      'if [ -z "$SKIP_GENERATED_DOCS" ]; then',
      `  node "${hookScriptPath("scripts/regen-generated-docs.mjs")}" --staged-only || exit $?`,
      "fi",
    ].join("\n"),
  },
  {
    hook: "commit-msg",
    id: "lax-commit-subject",
    body: [
      "# Rejects a subject that cites the size rule instead of naming the change.",
      "# Bypass: SKIP_COMMIT_SUBJECT_CHECK=1 git commit",
      "# Every worktree shares this hook; one checked out before the script existed skips it.",
      `subject_check="${hookScriptPath("scripts/check-commit-subject.mjs")}"`,
      'if [ -f "$subject_check" ]; then node "$subject_check" "$1" || exit $?; fi',
    ].join("\n"),
  },
  {
    hook: "pre-push",
    id: "lax-selfedit-guard",
    body: [
      '# Blocks pushes containing machine-generated "Agent selfedit-*" commits.',
      "# Bypass: SKIP_SELFEDIT_GUARD=1 git push",
      `node "${hookScriptPath("scripts/selfedit-push-guard.mjs")}" <&0 || exit $?`,
    ].join("\n"),
  },
];

for (const spec of HOOKS) {
  const result = installHookBlock(spec);
  if (result.action === "skipped") {
    console.log(`[git-hooks] ${result.reason} — nothing to install`);
    break;
  }
  console.log(`[git-hooks] ${spec.id} ${result.action} in ${result.hookPath}`);
}

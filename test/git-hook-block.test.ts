/**
 * Hooks are the one place a second installer destroys the first: they all write
 * the same file. install-hooks.sh used to `cat >` over pre-commit, silently
 * deleting the generated-docs block that keeps a stale docs/codebase-map.md out
 * of a commit — and a stale map on main is what makes `npm run build` fail on
 * the candidate the rolling updater compiles.
 *
 * These pin the merge rules that let independent blocks coexist.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeHookBlock, installHookBlock, hookScriptPath } from "../scripts/git-hook-block.mjs";

const DOCS = { id: "lax-generated-docs", body: "node regen.mjs --staged-only || exit $?" };
const EVAL = { id: "lax-eval-gate", body: "node eval-gate.mjs || exit $?" };

describe("mergeHookBlock", () => {
  it("creates a runnable hook when none exists", () => {
    const { content, action } = mergeHookBlock("", DOCS.id, DOCS.body);
    expect(action).toBe("created");
    expect(content.startsWith("#!/bin/sh\n")).toBe(true);
    expect(content).toContain(DOCS.body);
  });

  it("appends beside a hook someone else wrote, preserving it", () => {
    const foreign = "#!/bin/sh\necho my own hook\n";
    const { content, action } = mergeHookBlock(foreign, DOCS.id, DOCS.body);
    expect(action).toBe("appended");
    expect(content).toContain("echo my own hook");
    expect(content).toContain(DOCS.body);
  });

  it("is idempotent — re-running does not stack duplicate blocks", () => {
    let content = mergeHookBlock("", DOCS.id, DOCS.body).content;
    for (let i = 0; i < 3; i++) content = mergeHookBlock(content, DOCS.id, DOCS.body).content;
    expect(content.split(`# >>> ${DOCS.id} >>>`).length - 1).toBe(1);
  });

  it("updates a block in place when its body changes", () => {
    const first = mergeHookBlock("", DOCS.id, "node old.mjs").content;
    const { content, action } = mergeHookBlock(first, DOCS.id, "node new.mjs");
    expect(action).toBe("updated");
    expect(content).toContain("node new.mjs");
    expect(content).not.toContain("node old.mjs");
  });

  // The regression that motivated the shared helper.
  it("two different blocks coexist, and updating one leaves the other intact", () => {
    let content = mergeHookBlock("", DOCS.id, DOCS.body).content;
    content = mergeHookBlock(content, EVAL.id, EVAL.body).content;
    expect(content).toContain(DOCS.body);
    expect(content).toContain(EVAL.body);

    content = mergeHookBlock(content, DOCS.id, "node regen.mjs --changed").content;
    expect(content).toContain("node regen.mjs --changed");
    expect(content).toContain(EVAL.body);
    expect(content.split("# >>>").length - 1).toBe(2);
  });

  it("keeps a foreign hook alive across an update of our block", () => {
    let content = mergeHookBlock("#!/bin/sh\nrun-my-linter\n", DOCS.id, "v1").content;
    content = mergeHookBlock(content, DOCS.id, "v2").content;
    expect(content).toContain("run-my-linter");
    expect(content).toContain("v2");
    expect(content).not.toContain("v1");
  });
});

describe("installHookBlock — writes into .git/hooks", () => {
  let hooksDir: string;
  beforeEach(() => { hooksDir = mkdtempSync(join(tmpdir(), "lax-hooks-")); });
  afterEach(() => { rmSync(hooksDir, { recursive: true, force: true }); });

  it("writes the hook file and reports where", () => {
    const r = installHookBlock({ hook: "pre-commit", id: DOCS.id, body: DOCS.body, hooksDir });
    expect(r.action).toBe("created");
    expect(existsSync(join(hooksDir, "pre-commit"))).toBe(true);
    expect(readFileSync(join(hooksDir, "pre-commit"), "utf-8")).toContain(DOCS.body);
  });

  it("does not disturb a different hook file", () => {
    writeFileSync(join(hooksDir, "pre-push"), "#!/bin/sh\nexisting push hook\n");
    installHookBlock({ hook: "pre-commit", id: DOCS.id, body: DOCS.body, hooksDir });
    expect(readFileSync(join(hooksDir, "pre-push"), "utf-8")).toContain("existing push hook");
  });

  it("reports skipped rather than throwing outside a git checkout", () => {
    // postinstall also runs for tarball installs, which have no .git at all.
    expect(installHookBlock({ hook: "pre-commit", id: DOCS.id, body: DOCS.body, hooksDir: null }).action)
      .toBe("skipped");
  });

  it("embeds a POSIX path the `sh` running the hook can execute", () => {
    // A Windows hook body is still interpreted by sh; backslashes would be
    // read as escapes and the hook would silently never run.
    expect(hookScriptPath("scripts/regen-generated-docs.mjs")).not.toContain("\\");
    expect(hookScriptPath("scripts/regen-generated-docs.mjs")).toContain("/scripts/regen-generated-docs.mjs");
  });
});

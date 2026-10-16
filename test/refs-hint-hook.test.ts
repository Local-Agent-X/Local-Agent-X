// The refs hint: a PostToolUse hook that, when an agent greps for a code
// symbol, points at `npm run refs -- <Name>`. It only ever adds a line of
// context, so the contract is: speak for a symbol-shaped search in a repo
// that has a `refs` script, stay silent otherwise, and never fail the call.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bashSearchPattern, hintFor, looksLikeSymbol, searchedName } from "../scripts/refs-hint-hook.mjs";

const REPO = resolve(__dirname, "..");
const HOOK = join(REPO, "scripts/refs-hint-hook.mjs");

describe("which searches get a hint", () => {
  it("one identifier, however the pattern wraps it", () => {
    expect(searchedName("destinationSpecsOf")).toBe("destinationSpecsOf");
    expect(searchedName("\\bToolPolicyRow\\b")).toBe("ToolPolicyRow");
    expect(searchedName("hasCapability\\(")).toBe("hasCapability");
    expect(searchedName("hasCapability\\s*\\(")).toBe("hasCapability");
    expect(searchedName("export function foo")).toBeNull();
    expect(searchedName("a|b")).toBeNull();
  });

  it("a code-shaped name, not a word", () => {
    for (const n of ["hasCapability", "ToolPolicyRow", "TOOL_POLICIES", "isTrustedSend"]) expect(looksLikeSymbol(n), n).toBe(true);
    for (const n of ["error", "import", "TODO", "README", "Error", "abc"]) expect(looksLikeSymbol(n), n).toBe(false);
  });

  it("the pattern of a grep or rg command line", () => {
    expect(bashSearchPattern(`rg -n "hasCapability" src/`)).toBe("hasCapability");
    expect(bashSearchPattern(`grep -rn --include=*.ts ToolPolicyRow src`)).toBe("ToolPolicyRow");
    expect(bashSearchPattern(`git grep -e isTrustedSend`)).toBe("isTrustedSend");
    expect(bashSearchPattern(`cd src && rg outputOf`)).toBe("outputOf");
    expect(bashSearchPattern(`npm run build`)).toBeNull();
  });
});

describe("the hint itself", () => {
  it("names the repo's refs command, in a repo that has one", () => {
    const hint = hintFor({ tool_name: "Grep", tool_input: { pattern: "hasCapability" }, cwd: REPO });
    expect(hint).toContain("npm run refs -- hasCapability");
  });

  it("says nothing in a repo without a refs script, or for a plain word", () => {
    const bare = mkdtempSync(join(tmpdir(), "refs-hint-"));
    writeFileSync(join(bare, "package.json"), `{ "scripts": { "build": "tsc" } }`);
    expect(hintFor({ tool_name: "Grep", tool_input: { pattern: "hasCapability" }, cwd: bare })).toBeNull();
    expect(hintFor({ tool_name: "Grep", tool_input: { pattern: "error" }, cwd: REPO })).toBeNull();
    expect(hintFor({ tool_name: "Read", tool_input: { file_path: "x" }, cwd: REPO })).toBeNull();
  });

  it("as a hook: the PostToolUse context once per name per session, and exit 0 even on garbage", () => {
    const session = `test-${process.pid}-${Date.now()}`;
    const run = (input: string) => spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env: { ...process.env, REFS_HINT: "" } });
    const event = JSON.stringify({ session_id: session, tool_name: "Grep", tool_input: { pattern: "outputOf" }, cwd: REPO });
    const first = run(event);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUse", additionalContext: expect.stringContaining("npm run refs -- outputOf") });
    expect(run(event).stdout).toBe("");
    const garbage = run("not json");
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe("");
  });
});

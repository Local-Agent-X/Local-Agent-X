// The server-stamped `_` arguments have one reader each (internal-args.ts): a
// tool that reads `args._sessionId` itself decides alone how an absent or
// malformed stamp reads, and a renamed stamp leaves it reading nothing with
// nothing failing. This scan reads every source file and fails on a `_` key
// read off an arguments object outside the accessor module, and on a stamp
// written outside the dispatch pipeline.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import fg from "fast-glob";
import { sessionIdOf, cwdOf, onEventOf, withoutInternalArgs, callContextOf, unattendedCall, userGrantOf } from "./internal-args.js";

const ACCESSORS = "src/tool-execution/internal-args.ts";

/** Where a stamp is written, and why there. */
const WRITERS: Record<string, string> = {
  "src/tool-execution/resolve-tool.ts": "the dispatcher stamps session, operation, message, turn, cwd, event sink, call id and call context",
  "src/tool-execution/tool-runner.ts": "the runner stamps its progress sink per attempt",
  "src/tool-execution/run-sandboxed.ts": "the sandbox phase stamps the user's one-shot grant for a gate inside the tool",
  "src/tool-execution/enforce-policy.ts": "the worktree gate anchors bash at the agent's worktree",
  "src/tools/plugins.ts": "the build_app binding stamps the chat turn's provider and model",
  "src/tools/browser-tools/gates.ts": "the download gate binds its approval for the page action that follows",
};

/** `_` keys read off an object that happens to be called `args` but is not a
 *  tool's arguments. */
const NOT_TOOL_ARGS: Record<string, string> = {
  "src/classifiers/app-tier-classify.ts": "classifier options; `_llm` is the test seam for the model client",
  "src/classifiers/test-deletion-classify.ts": "classifier options; `_llm` is the test seam for the model client",
};

interface Hit { file: string; line: number; key: string; write: boolean }

const isAssignment = (kind: ts.SyntaxKind): boolean => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;

function scan(): Hit[] {
  const hits: Hit[] = [];
  const files = fg.sync(["src/**/*.ts"], { ignore: ["**/*.test.ts", "**/*.test-helper.ts", "**/vendor/**"] });
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      let key: string | undefined;
      let target: ts.Expression | undefined;
      if (ts.isPropertyAccessExpression(node) && node.name.text.startsWith("_")) { key = node.name.text; target = node.expression; }
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text.startsWith("_")) { key = node.argumentExpression.text; target = node.expression; }
      if (key && target && /[aA]rgs$/.test(target.getText()) && key !== "_raw") {
        const write = ts.isBinaryExpression(node.parent) && node.parent.left === node && isAssignment(node.parent.operatorToken.kind);
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        hits.push({ file: file.replace(/\\/g, "/"), line: line + 1, key, write });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return hits;
}

describe("server-stamped arguments are read through internal-args.ts only", () => {
  const hits = scan();

  it("every `_` key read off an arguments object is in the accessor module", () => {
    const reads = hits.filter((h) => !h.write && h.file !== ACCESSORS && !(h.file in NOT_TOOL_ARGS)).map((h) => `${h.file}:${h.line} ${h.key}`);
    expect(reads, "read the stamp through its accessor in src/tool-execution/internal-args.ts (add one if the stamp is new)").toEqual([]);
  });

  it("every stamp is written by the dispatch pipeline", () => {
    const writes = hits.filter((h) => h.write && !(h.file in WRITERS)).map((h) => `${h.file}:${h.line} ${h.key}`);
    expect(writes, "a stamp is the server's channel to a tool: stamp it in resolve-tool.ts, never inside a tool").toEqual([]);
    for (const file of Object.keys(WRITERS)) expect(hits.some((h) => h.write && h.file === file), `${file} no longer stamps anything — drop it from WRITERS`).toBe(true);
  });

  it("the accessors read what the dispatcher writes and nothing the model could forge", () => {
    expect(sessionIdOf({ _sessionId: "s1" })).toBe("s1");
    expect(sessionIdOf({ _sessionId: "" })).toBeUndefined();
    expect(sessionIdOf({ _sessionId: 7 })).toBeUndefined();
    expect(cwdOf({ _cwd: "  " })).toBeUndefined();
    expect(onEventOf({ _onEvent: "not a function" })).toBeUndefined();
    expect(withoutInternalArgs({ path: "a", _sessionId: "s1", _onEvent: () => {} })).toEqual({ path: "a" });
    expect(callContextOf({ _callContext: "cron" })).toBe("cron");
    expect(callContextOf({ _callContext: "mars" })).toBeUndefined();
    expect(unattendedCall({ _callContext: "cron" })).toBe(true);
    expect(unattendedCall({ _callContext: "local" })).toBe(false);
    expect(unattendedCall({})).toBe(false);
    expect(userGrantOf({ _userGrant: "grant-1" })).toBe("grant-1");
    expect(userGrantOf({ _userGrant: 3 })).toBeUndefined();
  });
});

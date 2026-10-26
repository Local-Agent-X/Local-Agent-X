/**
 * code_handoff puts a "Continue in Code mode" offer on the chat for a brief
 * the agent wrote inside the repo — and only then: a folder that is not one,
 * or a brief outside it, is refused and nothing is offered.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeHandoffTool } from "./code-handoff-tool.js";
import type { ServerEvent } from "../types.js";

function withRepo(run: (repo: string) => Promise<void>) {
  return async () => {
    const repo = mkdtempSync(join(tmpdir(), "lax-code-handoff-"));
    try { await run(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
  };
}

describe("code_handoff", () => {
  it("offers the brief on the chat, with the repo and the brief's path in it", withRepo(async (repo) => {
    mkdirSync(join(repo, "docs", "handoff"), { recursive: true });
    writeFileSync(join(repo, "docs", "handoff", "planner.md"), "# Goal\n");
    const events: ServerEvent[] = [];
    const r = await codeHandoffTool.execute({ folder: repo, brief: join(repo, "docs", "handoff", "planner.md"), _onEvent: (e: ServerEvent) => events.push(e), _toolCallId: "tc-9" });
    expect(r.isError).toBeFalsy();
    expect(events).toEqual([{ type: "code_handoff", toolCallId: "tc-9", folder: repo, brief: "docs/handoff/planner.md" }]);
  }));

  it("refuses a brief outside the repo, a missing brief and a folder that is not one, and offers nothing", withRepo(async (repo) => {
    const events: ServerEvent[] = [];
    const onEvent = (e: ServerEvent) => events.push(e);
    writeFileSync(join(repo, "..", "outside-brief.md"), "x");
    try {
      expect((await codeHandoffTool.execute({ folder: repo, brief: join(repo, "..", "outside-brief.md"), _onEvent: onEvent })).isError).toBe(true);
    } finally {
      rmSync(join(repo, "..", "outside-brief.md"), { force: true });
    }
    expect((await codeHandoffTool.execute({ folder: repo, brief: join(repo, "missing.md"), _onEvent: onEvent })).isError).toBe(true);
    expect((await codeHandoffTool.execute({ folder: join(repo, "nope"), brief: "a.md", _onEvent: onEvent })).isError).toBe(true);
    expect(events).toEqual([]);
  }));
});

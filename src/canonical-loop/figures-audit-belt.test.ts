// The figures audit (the verifier, and the correction after it) runs without
// the step-list tools. Given task_create, the open-steps seed told the
// verifier to lay out its steps; live 2026-11-24 it spent six of seven calls
// on that list and ran out of budget before fetching one source, so the deck's
// note said the figures couldn't be checked.
import { describe, it, expect } from "vitest";
import { figuresAuditBelt } from "./verification-submit.js";
import { toolsTagged } from "../tool-registry.js";
import type { ToolDefinition } from "../types.js";

const tool = (name: string) => ({ name }) as ToolDefinition;

describe("the figures audit's belt", () => {
  it("drops every step-list tool and keeps the tools the audit uses", () => {
    const stepList = toolsTagged("tasks");
    expect(stepList).toEqual(expect.arrayContaining(["task_create", "task_update"]));
    const belt = figuresAuditBelt([...stepList, "read", "web_search", "web_fetch", "spreadsheet", "document"].map(tool));
    expect(belt.map((t) => t.name)).toEqual(["read", "web_search", "web_fetch", "spreadsheet", "document"]);
  });
});

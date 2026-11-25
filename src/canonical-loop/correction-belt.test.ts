// The correction's belt carries the office tools. They are deferred
// everywhere, so the build worker's belt has no tool that edits a deck, and
// live 2026-11-25 a correction reached for the text `edit` tool on a .pptx and
// the deck was lost.
import { describe, it, expect, vi } from "vitest";
import type { ToolDefinition } from "../types.js";

const tool = (name: string) => ({ name }) as ToolDefinition;

vi.mock("../ops/tools/delegated-toolset.js", () => ({
  delegatedToolsetForOp: () => ["read", "edit", "write", "bash", "web_fetch", "task_create", "spreadsheet"].map(tool),
}));
vi.mock("../tools/tool-search.js", () => ({
  unifiedRegistry: { get: (name: string) => (name === "pdf" ? undefined : tool(name)) },
}));

const { correctionBelt } = await import("./verification-correct.js");
const { OFFICE_KIT } = await import("../tools/tool-kits.js");

describe("the correction's belt", () => {
  it("adds every registered office tool once, and drops the step list", () => {
    const names = correctionBelt("C:/w").map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["presentation", "document", "spreadsheet", "edit", "read"]));
    expect(names.filter((n) => n === "spreadsheet")).toHaveLength(1);
    expect(names).not.toContain("task_create");
    expect(names).not.toContain("pdf");
    expect(OFFICE_KIT).toContain("presentation");
  });
});

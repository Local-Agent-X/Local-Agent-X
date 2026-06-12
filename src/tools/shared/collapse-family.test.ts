import { describe, it, expect } from "vitest";
import { collapseFamily } from "./collapse-family.js";
import type { ToolDefinition } from "../../types.js";

const inner = (name: string, required: string[] = ["x"]): ToolDefinition => ({
  name,
  description: `Does ${name}. Second sentence with detail.`,
  parameters: { type: "object", properties: { x: { type: "string" }, y: { type: "string" } }, required },
  async execute(args) {
    return { content: JSON.stringify({ ran: name, args }) };
  },
});

describe("collapseFamily", () => {
  const tool = collapseFamily({
    name: "fam",
    intro: "Family intro.",
    actions: { alpha: inner("fam_alpha"), beta: inner("fam_beta", []) },
  });

  it("builds an action enum + per-action signature docs from the inner schemas", () => {
    const schema = tool.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.properties.action.enum).toEqual(["alpha", "beta"]);
    expect(schema.required).toEqual(["action"]);
    expect(tool.description).toContain("• alpha(x, y?): Does fam_alpha.");
    expect(tool.description).toContain("• beta(x?, y?): Does fam_beta.");
    // default docs are first-sentence only
    expect(tool.description).not.toContain("Second sentence");
  });

  it("dispatches nested params and preserves executor-injected underscore keys", async () => {
    const r = await tool.execute({ action: "alpha", params: { x: "1" }, _sessionId: "s1" });
    const parsed = JSON.parse(String(r.content));
    expect(parsed.ran).toBe("fam_alpha");
    expect(parsed.args).toEqual({ x: "1", _sessionId: "s1" });
  });

  it("dispatches flat args (no params object)", async () => {
    const r = await tool.execute({ action: "beta", x: "2" });
    expect(JSON.parse(String(r.content)).args).toEqual({ x: "2" });
  });

  it("nested params win over flat keys on collision", async () => {
    const r = await tool.execute({ action: "alpha", x: "flat", params: { x: "nested" } });
    expect(JSON.parse(String(r.content)).args.x).toBe("nested");
  });

  it("rejects an unknown action with the valid list", async () => {
    const r = await tool.execute({ action: "gamma" });
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain("alpha, beta");
  });

  it("flat properties style exposes the union schema and keeps full docs when asked", () => {
    const flat = collapseFamily({
      name: "office",
      intro: "Office intro.",
      actions: { read: inner("office_read") },
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
      fullActionDocs: true,
    });
    const schema = flat.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(["action", "file_path"]);
    expect(schema.required).toEqual(["action", "file_path"]);
    expect(flat.description).toContain("Second sentence");
  });
});

describe("collapsed real families", () => {
  it("protocol family exposes one protocol tool + marketplace passthrough, all actions wired", async () => {
    const { createProtocolFamilyTools } = await import("../../protocols/protocol-tool.js");
    const tools = createProtocolFamilyTools();
    const names = tools.map((t) => t.name);
    expect(names[0]).toBe("protocol");
    expect(names).toContain("marketplace_search");
    expect(names.some((n) => n.startsWith("protocol_"))).toBe(false);

    const protocol = tools[0];
    const schema = protocol.parameters as { properties: { action: { enum: string[] } } };
    // The five destructive actions must stay present — approval gating keys on them.
    for (const a of ["delete", "prune", "archive_bulk", "rollback_undo", "var_delete"]) {
      expect(schema.properties.action.enum).toContain(a);
    }
    expect(schema.properties.action.enum.length).toBeGreaterThanOrEqual(30);

    const bad = await protocol.execute({ action: "definitely_not_real" });
    expect(bad.isError).toBe(true);
  });

  it("office families each collapse to a single tool with the expected actions", async () => {
    const { spreadsheetTools } = await import("../spreadsheet-tools.js");
    const { documentTools } = await import("../document-tools.js");
    const { presentationTools } = await import("../presentation-tools.js");
    const { pdfTools } = await import("../pdf-tools.js");
    const expected: Record<string, { tools: { name: string; parameters: unknown }[]; actions: string[] }> = {
      spreadsheet: { tools: spreadsheetTools, actions: ["read", "write", "edit", "query"] },
      document: { tools: documentTools, actions: ["create", "read", "edit", "template"] },
      presentation: { tools: presentationTools, actions: ["create", "add_slide", "from_outline", "edit"] },
      pdf: { tools: pdfTools, actions: ["read", "create", "merge", "extract_tables"] },
    };
    for (const [name, { tools, actions }] of Object.entries(expected)) {
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe(name);
      const schema = tools[0].parameters as { properties: { action: { enum: string[] } } };
      expect(schema.properties.action.enum.sort()).toEqual([...actions].sort());
    }
  });
});

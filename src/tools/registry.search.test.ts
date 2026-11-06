import { describe, expect, it } from "vitest";
import { UnifiedToolRegistry } from "./registry.js";
import type { ToolDefinition } from "../types.js";

const tool = (name: string, description = `${name} does a thing.`): ToolDefinition => ({
  name,
  description,
  parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "" }),
});

function registry(): UnifiedToolRegistry {
  const r = new UnifiedToolRegistry();
  for (const t of [
    tool("gmail_read", "Read email from the user's Gmail inbox."),
    tool("gmail_send", "Send an email through Gmail."),
    tool("gmail_search", "Search Gmail messages."),
    tool("gmail_label", "Label Gmail messages."),
    tool("gmail_draft", "Draft a Gmail email."),
    tool("gmail_archive", "Archive Gmail email."),
    tool("calendar_list", "List calendar events."),
  ]) r.register(t, { tags: ["email"] });
  return r;
}

const names = (ts: ToolDefinition[]) => ts.map((t) => t.name);

describe("tool_search by name", () => {
  it("loads exactly the tool it names, not its four keyword neighbours", () => {
    expect(names(registry().search("gmail_read"))).toEqual(["gmail_read"]);
  });

  it("loads several named tools at once, and only those", () => {
    expect(names(registry().search("gmail_read, gmail_send"))).toEqual(["gmail_read", "gmail_send"]);
    expect(names(registry().search("gmail_read gmail_send calendar_list"))).toEqual(["gmail_read", "gmail_send", "calendar_list"]);
  });

  it("still finds a name typed a letter or two off, first", () => {
    expect(names(registry().search("gmial_read"))[0]).toBe("gmail_read");
    expect(names(registry().search("gmail_raed"))[0]).toBe("gmail_read");
    expect(names(registry().search("calendar_lst"))[0]).toBe("calendar_list");
  });

  it("keeps keyword search for a description of what is needed", () => {
    const found = names(registry().search("calendar events"));
    expect(found[0]).toBe("calendar_list");
  });
});

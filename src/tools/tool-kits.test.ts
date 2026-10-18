import { describe, expect, it } from "vitest";
import { BUILDER_KIT, CODING_KIT, OFFICE_KIT, selectTools } from "./tool-kits.js";
import { toolsTagged } from "../tool-registry.js";

describe("a tool set is chosen by what its tools are for", () => {
  it("selects every tool carrying any of the tags, in table order", () => {
    expect(toolsTagged("file-search")).toEqual(["glob", "grep"]);
    expect(selectTools({ tags: ["file-read", "file-search"] })).toEqual(toolsTagged("file-read", "file-search"));
  });

  it("adds a named exception after the tagged tools and drops a named one", () => {
    expect(selectTools({ tags: ["file-search"], plus: { read: "why" } })).toEqual(["glob", "grep", "read"]);
    expect(selectTools({ tags: ["file-search"], except: { grep: "why" } })).toEqual(["glob"]);
  });

  it("refuses an exception that does nothing or names no tool", () => {
    expect(() => selectTools({ tags: ["file-search"], plus: { grep: "already covered" } })).toThrow(/already cover/);
    expect(() => selectTools({ tags: ["file-search"], except: { read: "not covered" } })).toThrow(/do not cover/);
    expect(() => selectTools({ tags: ["file-search"], plus: { no_such_tool: "dead" } })).toThrow(/no policy row/);
  });

  it("the worker kits are the coding verbs, the builder's web and viewer, and the office umbrellas", () => {
    expect([...CODING_KIT].sort()).toEqual(["bash", "edit", "glob", "grep", "read", "write"]);
    expect(BUILDER_KIT.filter((name) => !CODING_KIT.includes(name)).sort()).toEqual(["view_image", "web_fetch", "web_search"]);
    expect([...OFFICE_KIT].sort()).toEqual(["document", "pdf", "presentation", "spreadsheet"]);
  });
});

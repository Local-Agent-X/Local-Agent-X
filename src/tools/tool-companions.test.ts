import { describe, expect, it } from "vitest";
import { companionsFor } from "./tool-companions.js";

// delete_file's result text offers the undo; its row names restore_file as a
// companion, so the tier cap can never ship the offer without the tool.
describe("companionsFor", () => {
  it("brings each tool's row companions", () => {
    expect(companionsFor(["delete_file", "read"])).toEqual(["restore_file"]);
  });

  it("adds nothing already present, and nothing for a tool that names none", () => {
    expect(companionsFor(["delete_file", "restore_file"])).toEqual([]);
    expect(companionsFor(["read", "no_such_tool"])).toEqual([]);
  });
});

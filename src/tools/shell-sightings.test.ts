// A file's whole current text in a recent shell result counts as seen; a
// fragment, an empty file or another session's output does not.
import { beforeEach, describe, expect, it } from "vitest";
import { _resetShellSightingsForTest, recordShellOutput, shellShowedContent } from "./shell-sightings.js";

beforeEach(() => _resetShellSightingsForTest());

describe("shellShowedContent", () => {
  it("finds a file's whole text inside a larger output, across line-ending styles", () => {
    recordShellOutput("s", "=== a.ts\r\nconst a = 1;\r\nconst b = 2;\r\n=== b.ts\r\n");
    expect(shellShowedContent("s", "const a = 1;\nconst b = 2;\n")).toBe(true);
  });

  it("reads a whole file printed with line-end marks (cat -A) or line numbers (cat -n)", () => {
    const file = "const a = 1;\n\tindented$;\n";
    recordShellOutput("s", "=== a.ts\nconst a = 1;$\n^Iindented$;$\n");
    expect(shellShowedContent("s", file)).toBe(true);
    recordShellOutput("t", "     1\tconst a = 1;\n     2\t\tindented$;\n");
    expect(shellShowedContent("t", file)).toBe(true);
    recordShellOutput("u", "     1\tconst a = 1;$\n");
    expect(shellShowedContent("u", file)).toBe(false); // numbered, but only part of it
  });

  it("never credits a fragment, an empty file, or another session", () => {
    recordShellOutput("s", "const a = 1;\n");
    expect(shellShowedContent("s", "const a = 1;\nconst b = 2;\n")).toBe(false);
    expect(shellShowedContent("s", "")).toBe(false);
    expect(shellShowedContent("other", "const a = 1;\n")).toBe(false);
  });

  it("forgets the oldest outputs past its bound", () => {
    recordShellOutput("s", "early unique text\n");
    for (let i = 0; i < 40; i++) recordShellOutput("s", `filler ${i}\n`);
    expect(shellShowedContent("s", "early unique text\n")).toBe(false);
    expect(shellShowedContent("s", "filler 39\n")).toBe(true);
  });
});

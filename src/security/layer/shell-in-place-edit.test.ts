import { describe, expect, it } from "vitest";
import { inPlaceEditTargets } from "./shell-in-place-edit.js";

describe("inPlaceEditTargets", () => {
  it("names the files after sed's script, not the script", () => {
    expect(inPlaceEditTargets("sed -i 's/a/b/' notes.txt other.txt")).toEqual(["notes.txt", "other.txt"]);
    expect(inPlaceEditTargets("sed -i /obsolete/d notes.txt")).toEqual(["notes.txt"]);
  });

  it("takes every operand as a file when -e or -f gave the script", () => {
    expect(inPlaceEditTargets("sed -i -e 's/a/b/' -e 's/c/d/' /etc/hosts")).toEqual(["/etc/hosts"]);
    expect(inPlaceEditTargets("sed --in-place -f fix.sed a.txt")).toEqual(["a.txt"]);
  });

  it("reads awk's inplace extension, whose -i and -v take a value", () => {
    expect(inPlaceEditTargets("gawk -i inplace -v n=1 '{ print }' data.csv")).toEqual(["data.csv"]);
  });

  it("names nothing for a command that edits nothing in place", () => {
    expect(inPlaceEditTargets("sed -n 's/a/b/p' notes.txt")).toEqual([]);
    expect(inPlaceEditTargets("grep 'sed -i' notes.md")).toEqual([]);
  });

  it("finds the editor behind a chain, and only its own operands", () => {
    expect(inPlaceEditTargets("cd repo && sed -i 's/a/b/' src/x.ts; psql -f /w/schema.sql")).toEqual(["src/x.ts"]);
  });
});

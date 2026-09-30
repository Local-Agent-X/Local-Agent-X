import { describe, expect, it } from "vitest";
import { projectNamesInText } from "./skill-review-project-names.js";
import { resolve } from "node:path";

const HOME = resolve("C:/Users/peter").toLowerCase();
const WS = resolve("C:/Users/peter/local-agent-x/workspace").toLowerCase();
const ROOTS = [HOME, WS, resolve(WS, "apps").toLowerCase()];

describe("project names named by a reviewed op's paths", () => {
  it("takes the first segment under the home dir, the workspace, and workspace/apps", () => {
    const text = [
      'cd "C:\\Users\\peter\\Jobs-In-Order" && git push origin master',
      "read C:/Users/peter/local-agent-x/workspace/scanprogress-src/app/page.tsx",
      "write C:/Users/peter/local-agent-x/workspace/apps/studio-ops/index.html",
    ].join("\n");
    // local_agent_x is right: the workspace lives inside a repo under the home dir.
    expect(projectNamesInText(text, ROOTS).sort()).toEqual(["jobs_in_order", "local_agent_x", "scanprogress_src", "studio_ops"]);
  });

  it("does not need a trailing separator: a bare repo dir in a shell command counts", () => {
    expect(projectNamesInText("git -C C:\\Users\\peter\\merchhelm push origin master", ROOTS)).toEqual(["merchhelm"]);
  });

  it("understands Git Bash drive spelling", () => {
    expect(projectNamesInText("ls /c/Users/peter/merchhelm/src", ROOTS)).toEqual(["merchhelm"]);
  });

  it("ignores paths outside every root and bare root paths", () => {
    expect(projectNamesInText("D:/code/other/repo/file.ts and C:/Users/peter/ alone", ROOTS)).toEqual([]);
  });
});

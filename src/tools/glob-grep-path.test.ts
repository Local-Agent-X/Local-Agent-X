import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { LAXConfig } from "../types.js";
import { setRuntimeConfig } from "../config.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { searchBase } from "./glob-tool.js";
import { searchRoot } from "./grep-tool.js";

// glob and grep used to resolve their search root with a raw `resolve(cwd, path)`
// — no ~ expansion and anchored to process.cwd() instead of the project root, so
// a "~/..." or workspace-relative root failed until the model retried with an
// absolute path. Both now route through resolveAgentPath, the SAME resolver the
// file tools and the security gate use. These tests guard against a regression
// back to the cwd join.
describe("glob/grep search-root resolution", () => {
  const WS = resolve("/lax-test-home/Documents/Local Agent X/workspace");
  beforeAll(() => setRuntimeConfig({ workspace: WS } as Partial<LAXConfig> as LAXConfig));

  const cases: Array<[string, string]> = [
    ["expands a leading ~/", "~/Documents/code"],
    ["anchors a workspace-relative root to the project root", "apps/demo"],
    ["passes an absolute root through", resolve("/srv/data")],
  ];

  for (const [label, input] of cases) {
    it(`glob ${label}`, () => expect(searchBase(input)).toBe(resolveAgentPath(input)));
    it(`grep ${label}`, () => expect(searchRoot({ path: input })).toBe(resolveAgentPath(input)));
  }

  it("a ~/ root resolves under the user's home, not the project root", () => {
    expect(searchBase("~/x").startsWith(homedir())).toBe(true);
    expect(searchRoot({ path: "~/x" }).startsWith(homedir())).toBe(true);
  });

  it("a workspace-relative root anchors to the project root, NOT process.cwd()", () => {
    expect(searchBase("apps/demo")).toBe(resolve(WS, "..", "apps", "demo"));
    expect(searchBase("apps/demo").startsWith(process.cwd())).toBe(false);
  });

  it("an absent path falls back to cwd (unchanged behavior)", () => {
    expect(searchBase(undefined)).toBe(process.cwd());
    expect(searchRoot({})).toBe(process.cwd());
    expect(searchBase("")).toBe(process.cwd());
  });
});

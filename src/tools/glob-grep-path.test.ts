import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { LAXConfig } from "../types.js";
import { setRuntimeConfig } from "../config.js";
import { resolveAgentPath, projectRoot, setSessionWorkRoot, clearSessionWorkRoot, sessionWorkRootOf } from "../workspace/paths.js";
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

  // An absent path used to fall back to process.cwd() — in the dev server the
  // git checkout, not the project — so a bare glob("**/*foo*") searched the
  // wrong tree and returned nothing while read/bash looked in the project
  // root. Both now resolve "." through resolveAgentPath: ONE rule.
  it("an absent path resolves to the project root, the same root as a bare relative read", () => {
    const root = resolve(WS, "..");
    expect(searchBase(undefined)).toBe(root);
    expect(searchBase("")).toBe(root);
    expect(searchRoot({})).toBe(root);
    expect(searchRoot({ path: "" })).toBe(root);
    expect(searchBase(undefined)).toBe(resolveAgentPath("."));
    expect(searchBase(undefined)).toBe(projectRoot());
  });

  it("an absent path never falls back to process.cwd()", () => {
    expect(searchBase(undefined)).not.toBe(process.cwd());
    expect(searchRoot({})).not.toBe(process.cwd());
  });

  it("with a session work root registered, an absent path resolves to that root (both tools)", () => {
    const sid = "glob-grep-path-session";
    const work = resolve("/lax-test-home/projects/chunk-worker");
    setSessionWorkRoot(sid, work);
    try {
      expect(searchBase(undefined, sid)).toBe(sessionWorkRootOf(sid));
      expect(searchRoot({ _sessionId: sid })).toBe(sessionWorkRootOf(sid));
      // and a relative path anchors there too — same resolver
      expect(searchBase("src", sid)).toBe(resolve(sessionWorkRootOf(sid)!, "src"));
    } finally {
      clearSessionWorkRoot(sid);
    }
    expect(searchBase(undefined, sid)).toBe(resolve(WS, ".."));
  });
});

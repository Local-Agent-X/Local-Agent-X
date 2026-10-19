// The live scaffold config must collect ONE file. Built with mergeConfig it
// concatenated `include` with the base list and `npm run test:scaffold-live`
// ran the entire suite before the creators (2026-10-18).
import { describe, expect, it } from "vitest";
import live from "../vitest.scaffold-live.config.js";
import base from "../vitest.config.js";

describe("vitest.scaffold-live.config", () => {
  it("collects only the live scaffold test, gates it open, and keeps the base settings", () => {
    expect(live.test?.include).toEqual(["test/scaffold-live.test.ts"]);
    expect(live.test?.env).toMatchObject({ ...base.test?.env, LAX_SCAFFOLD_LIVE: "1" });
    expect(live.test?.pool).toBe(base.test?.pool);
    expect(live.test?.setupFiles).toEqual(base.test?.setupFiles);
  });
});

// The weekly run tests the creators under the Node LAX installs: npm 10's
// resolver crashed inside nuxi's install on a Node 22 runner (2026-10-19),
// where a user's machine runs Node 24 and npm 11.
describe("the scheduled scaffold-live workflow", () => {
  it("runs on the Node major LAX installs", async () => {
    const { readFileSync } = await import("node:fs");
    const { NODE_LTS_INSTALL } = await import("../scripts/installer/contract.mjs");
    const workflow = readFileSync(new URL("../.github/workflows/scaffold-live.yml", import.meta.url), "utf-8");
    expect(workflow.match(/node-version:\s*'?(\d+)/)?.[1]).toBe(String(NODE_LTS_INSTALL));
  });
});

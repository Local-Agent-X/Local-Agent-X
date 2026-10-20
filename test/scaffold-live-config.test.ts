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


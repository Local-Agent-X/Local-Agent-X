import { describe, it, expect } from "vitest";
import type { Page } from "playwright";
import { evaluateScript } from "./page-ops.js";

describe("evaluateScript timeout", () => {
  it("rejects a never-resolving script within the budget instead of hanging to the wedge", async () => {
    const page = { evaluate: () => new Promise(() => { /* never resolves */ }) } as unknown as Page;
    const start = Date.now();
    await expect(evaluateScript(page, "awaitsForever()", 100)).rejects.toThrow(/exceeded 100ms/);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("returns the value for a normal script (happy path intact)", async () => {
    const page = { evaluate: async () => "Acme Corp" } as unknown as Page;
    expect(await evaluateScript(page, "document.title", 1_000)).toBe("Acme Corp");
  });
});

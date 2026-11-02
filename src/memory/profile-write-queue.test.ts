// Profile writers read a file, await an LLM-backed dedupe or compaction, then
// overwrite it. Two in flight lost one's change; withProfileWrite runs them one
// at a time per memory directory.
import { describe, expect, it } from "vitest";
import { withProfileWrite } from "./profile-write-queue.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withProfileWrite", () => {
  it("a second read-modify-write reads what the first one wrote", async () => {
    let file = "base";
    const append = (text: string, waitMs: number) => withProfileWrite("/mem/a", async () => {
      const read = file;
      await tick(waitMs); // the dedupe / compaction call
      file = `${read}+${text}`;
    });
    await Promise.all([append("eot", 20), append("auto-extract", 0)]);
    expect(file).toBe("base+eot+auto-extract");
  });

  it("a failed write does not stall the next, and its error reaches its caller", async () => {
    const order: string[] = [];
    const failing = withProfileWrite("/mem/b", async () => { order.push("first"); throw new Error("blocked"); });
    const next = withProfileWrite("/mem/b", async () => { order.push("second"); return 2; });
    await expect(failing).rejects.toThrow("blocked");
    expect(await next).toBe(2);
    expect(order).toEqual(["first", "second"]);
  });

  it("different memory directories do not wait on each other", async () => {
    const order: string[] = [];
    const slow = withProfileWrite("/mem/c", async () => { await tick(20); order.push("c"); });
    const fast = withProfileWrite("/mem/d", async () => { order.push("d"); });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["d", "c"]);
  });
});

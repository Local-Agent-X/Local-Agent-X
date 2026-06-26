import { describe, it, expect } from "vitest";
import { withWedgeTimeout, BrowserWedgeError } from "./observation.js";

const hung = <T>(): Promise<T> => new Promise<T>(() => { /* never settles — a wedged CDP scan */ });

describe("withWedgeTimeout", () => {
  it("rejects with BrowserWedgeError when the scan exceeds the ceiling", async () => {
    await expect(withWedgeTimeout(hung(), 20)).rejects.toBeInstanceOf(BrowserWedgeError);
  });

  it("returns the result when the scan finishes in time", async () => {
    await expect(withWedgeTimeout(Promise.resolve("obs"), 1000)).resolves.toBe("obs");
  });
});

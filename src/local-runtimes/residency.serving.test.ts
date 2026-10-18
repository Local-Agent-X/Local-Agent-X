import { describe, it, expect } from "vitest";
import { isServingChat, markServingChat } from "./residency.js";

describe("chat requests in flight per model", () => {
  it("is serving while any request to the model is open, and idle once all end", () => {
    const first = markServingChat("qwen3.6:27b");
    const second = markServingChat("qwen3.6:27b");
    expect(isServingChat("qwen3.6:27b")).toBe(true);
    first();
    expect(isServingChat("qwen3.6:27b")).toBe(true);
    second();
    expect(isServingChat("qwen3.6:27b")).toBe(false);
  });

  it("ending a request twice cannot hide another open request", () => {
    const first = markServingChat("qwen3.6:27b");
    const second = markServingChat("qwen3.6:27b");
    first();
    first();
    expect(isServingChat("qwen3.6:27b")).toBe(true);
    second();
    expect(isServingChat("qwen3.6:27b")).toBe(false);
  });

  it("matches the model across tag spellings and leaves other models idle", () => {
    const end = markServingChat("llama3.2");
    expect(isServingChat("llama3.2:latest")).toBe(true);
    expect(isServingChat("qwen3.6:27b")).toBe(false);
    end();
  });
});

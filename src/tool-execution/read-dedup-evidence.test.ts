/**
 * Read-dedup may say "you already hold this file" only while the model's view
 * still carries the file's content. A read whose result the context pruner
 * replaced with a stub holds none: refusing the re-read then leaves the model
 * with a file it can neither see nor read again.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

vi.mock("../workspace/paths.js", () => ({ resolveAgentPath: (p: string) => p }));

const { readContentInView } = await import("./read-dedup-evidence.js");
const { pruneFinishedTurnToolResults } = await import("../context-manager/prune-tool-results.js");

const PATH = "/work/big.ts";
const history = (carriedStatus: boolean): ChatCompletionMessageParam[] => [
  { role: "user", content: "read the file" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: PATH }) } }] },
  { role: "tool", tool_call_id: "c1", content: `[ok, path="${PATH}"]\n${"x".repeat(5000)}`, ...(carriedStatus ? { _status: "ok" } : {}) } as ChatCompletionMessageParam,
  { role: "assistant", content: "read it" },
  { role: "user", content: "now edit it" },
];

describe("readContentInView", () => {
  it("is true while the read's content is in view", () => {
    expect(readContentInView(history(true), PATH, undefined)).toBe(true);
  });

  it("is false once the read's result was pruned to a stub, whatever status it carries", () => {
    for (const carried of [false, true]) {
      expect(readContentInView(pruneFinishedTurnToolResults(history(carried)), PATH, undefined), `carried=${carried}`).toBe(false);
    }
  });
});

import { describe, it, expect } from "vitest";
import { convertMessages } from "./request.js";

/**
 * A duplicate tool_use id must be renamed the SAME way on every conversion.
 *
 * convertMessages replays the whole history each turn. The suffix used to come
 * from a module-global counter, so the same historical row serialized as
 * `id_7` on one turn and `id_9` on the next — diverging the prompt-cache prefix
 * at an early index and silently killing the message-tier cache for the rest of
 * the op (the class fixed in the compaction/digest work).
 */
describe("convertMessages — duplicate tool_use ids are deterministic", () => {
  const history = [
    { role: "assistant", content: "", tool_calls: [
      { id: "toolu_dup", function: { name: "read", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "toolu_dup", content: "first" },
    { role: "assistant", content: "", tool_calls: [
      { id: "toolu_dup", function: { name: "read", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "toolu_dup", content: "second" },
  ];

  const idsOf = (msgs: unknown[]): string[] => {
    const out: string[] = [];
    for (const m of msgs as Array<{ content: unknown }>) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Array<{ type: string; id?: string }>) {
        if (b.type === "tool_use" && b.id) out.push(b.id);
      }
    }
    return out;
  };

  it("renames the same row identically across repeated conversions of one history", () => {
    const first = idsOf(convertMessages(structuredClone(history) as never));
    const second = idsOf(convertMessages(structuredClone(history) as never));
    const third = idsOf(convertMessages(structuredClone(history) as never));
    expect(first).toEqual(["toolu_dup", "toolu_dup_1"]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("still disambiguates, so no two tool_use blocks share an id", () => {
    const ids = idsOf(convertMessages(structuredClone(history) as never));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

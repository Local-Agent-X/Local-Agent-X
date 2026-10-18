import { describe, expect, it } from "vitest";
import { filterToolsForSession } from "./prepare-and-route.js";
import { toolsWhere } from "../../../tool-registry.js";

type Tools = Parameters<typeof filterToolsForSession>[0];
const named = (...names: string[]) => names.map((name) => ({ name })) as unknown as Tools;

// An IDE session's chat may not spawn or steer workers: the tools are each
// row's `hiddenFrom.ide`, so a new delegation tool joins by saying so.
describe("filterToolsForSession", () => {
  it("strips every tool a row hides from the IDE, and only in an IDE session", () => {
    const hidden = toolsWhere((row) => row.hiddenFrom?.ide !== undefined);
    expect(hidden).toEqual(expect.arrayContaining(["agent_spawn", "build_app", "agent_message"]));
    const tools = named(...hidden, "read", "edit");
    expect(filterToolsForSession(tools, "ide-123").map((t) => t.name)).toEqual(["read", "edit"]);
    expect(filterToolsForSession(tools, "chat-123")).toHaveLength(hidden.length + 2);
  });
});

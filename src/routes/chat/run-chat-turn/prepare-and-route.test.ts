import { describe, expect, it, vi } from "vitest";
import { filterToolsForSession, preparePerTurnRequest } from "./prepare-and-route.js";
import { toolsWhere } from "../../../tool-registry.js";

const prepared = vi.hoisted(() => ({ provider: "anthropic", model: "claude-opus-5-5" }));
const endChatModelResidency = vi.hoisted(() => vi.fn());
vi.mock("../../../agent-request/index.js", () => ({ prepareAgentRequest: vi.fn(async () => ({ ...prepared })) }));
vi.mock("../../../local-runtimes/residency.js", () => ({ endChatModelResidency }));

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

// A chat turn on a cloud model frees the GPU the last local chat held; one on a
// local model leaves it to resolve-target, which moves the hold itself.
describe("preparePerTurnRequest and the local model's residency hold", () => {
  const input = () => ({
    sessionId: "chat-1", message: "hi", sessionMessages: [], attachments: [],
    ctx: { config: {}, dataDir: "/tmp/lax" } as unknown as Parameters<typeof preparePerTurnRequest>[0]["ctx"],
  });

  it("a cloud chat ends the hold", async () => {
    endChatModelResidency.mockClear();
    Object.assign(prepared, { provider: "anthropic", model: "claude-opus-5-5" });
    await preparePerTurnRequest(input());
    expect(endChatModelResidency).toHaveBeenCalledTimes(1);
  });

  it("a local chat keeps it", async () => {
    endChatModelResidency.mockClear();
    Object.assign(prepared, { provider: "local", model: "qwen3.8:27b-172k" });
    await preparePerTurnRequest(input());
    expect(endChatModelResidency).not.toHaveBeenCalled();
  });
});

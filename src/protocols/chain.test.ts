// A protocol chain runs its links in order, each one's output kept under its
// key for the links after it. The links come from a model's tool call.
import { describe, expect, it } from "vitest";
import { advanceChain, createChain, createChainTools, getChainState, resolveInputs, startChain, type ChainLink } from "./chain.js";

const tool = (name: string) => createChainTools().find((t) => t.name === name)!;
const links: ChainLink[] = [
  { protocolName: "research", outputKey: "notes" },
  { protocolName: "draft", inputMapping: { source: "notes" }, outputKey: "text" },
  { protocolName: "review", inputMapping: { doc: "text", missing: "nothing" } },
];

describe("createChain", () => {
  it("needs two links, each naming a protocol", () => {
    expect(() => createChain({ name: "one", description: "", links: [links[0]] })).toThrow(/at least 2/);
    expect(() => createChain({ name: "none", description: "", links: undefined as unknown as ChainLink[] })).toThrow(/at least 2/);
    expect(() => createChain({ name: "bare", description: "", links: ["research", "draft"] as unknown as ChainLink[] })).toThrow(/links\[0\] must be an object with a protocolName/);
    expect(() => createChain({ name: "blank", description: "", links: [links[0], { protocolName: " " }] })).toThrow(/links\[1\]/);
    expect(createChain({ name: "ok", description: "", links }).links).toHaveLength(3);
  });
});

describe("the chain tools", () => {
  it("refuses a chain of bare names and stores nothing: it cannot then be started", async () => {
    const created = await tool("protocol_chain_create").execute({ name: "bare-names", description: "d", links: ["research", "draft"] });
    expect(created.isError).toBe(true);
    const started = await tool("protocol_chain_start").execute({ chainName: "bare-names" });
    expect(started.isError).toBe(true);
    expect(started.content).toMatch(/not found/);
  });

  it("runs a chain link by link, handing each link the outputs it asked for", async () => {
    const created = await tool("protocol_chain_create").execute({ name: "write-up", description: "d", links });
    expect(created.content).toContain("research → draft → review");
    const started = await tool("protocol_chain_start").execute({ chainName: "write-up" });
    expect(started.content).toContain("First protocol: research");
    const id = /ID: (\S+)/.exec(String(started.content))![1];

    const second = await tool("protocol_chain_advance").execute({ chainId: id, output: "the notes" });
    expect(second.content).toContain("Next protocol: draft");
    expect(second.content).toContain('{"source":"the notes"}');
    const third = await tool("protocol_chain_advance").execute({ chainId: id, output: "the text" });
    expect(third.content).toContain("Next protocol: review");
    expect(third.content).toContain('"doc":"the text"');
    const done = await tool("protocol_chain_advance").execute({ chainId: id, output: "approved" });
    expect(done.content).toMatch(/^Chain completed/);
    expect(getChainState(id)).toMatchObject({ status: "completed", outputs: { notes: "the notes", text: "the text" } });
    // A finished chain does not advance again.
    expect(advanceChain(id, "again")).toBeNull();
  });

  it("an input a link asks for that no earlier link produced is absent, not an error", () => {
    const chain = createChain({ name: "write-up", description: "d", links });
    const id = startChain(chain);
    expect(resolveInputs(id, links[2])).toEqual({ doc: undefined, missing: undefined });
    expect(resolveInputs("no-such-chain", links[2])).toEqual({});
  });
});

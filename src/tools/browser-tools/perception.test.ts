import { describe, expect, it } from "vitest";
import type { BrowserBackend } from "../../browser/backend.js";
import { handleReadConsole, handleReadNetwork } from "./perception.js";
import { BROWSER_TOOL_PARAMETERS } from "./description.js";

function fakeManager(over: Partial<Record<keyof BrowserBackend, unknown>>): BrowserBackend {
  return over as unknown as BrowserBackend;
}

describe("read_console / read_network handlers", () => {
  it("handleReadConsole returns the backend report wrapped as external content", async () => {
    const manager = fakeManager({
      readConsole: async () => "Console: 1 message(s) (1 error(s), 0 warning(s)), newest last:\n[error] boom",
    });
    const r = await handleReadConsole(manager);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("[error] boom");
    // Page-controlled text is wrapped like snapshot/downloads output.
    expect(r.content).toContain("UNTRUSTED");
  });

  it("handleReadNetwork returns the backend report wrapped as external content", async () => {
    const manager = fakeManager({
      readNetwork: async () => "Network: 1 request(s) captured (1 failed/error status), newest last:\nGET 500 https://x/\n0 request(s) in flight",
    });
    const r = await handleReadNetwork(manager);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("GET 500 https://x/");
    expect(r.content).toContain("UNTRUSTED");
  });

  it("the CDP backend's not-supported string flows through unchanged (no pretending)", async () => {
    const manager = fakeManager({
      readConsole: async () => "Console capture is not supported on the external-Chrome backend — it is available in the in-app browser. No console output was read.",
    });
    const r = await handleReadConsole(manager);
    expect(r.content).toContain("not supported on the external-Chrome backend");
  });
});

describe("action registration", () => {
  it("read_console and read_network are in the tool's action enum", () => {
    const actions = (BROWSER_TOOL_PARAMETERS.properties.action as { enum: string[] }).enum;
    expect(actions).toContain("read_console");
    expect(actions).toContain("read_network");
  });

  it("both actions classify as read-only in the tool's effect discriminator", async () => {
    const { createBrowserTools } = await import("./index.js");
    const [tool] = createBrowserTools(() => "sess");
    const effect = tool.effect as (args: Record<string, unknown>) => { class: string };
    expect(effect({ action: "read_console" })).toEqual({ class: "read-only" });
    expect(effect({ action: "read_network" })).toEqual({ class: "read-only" });
    expect(effect({ action: "navigate" })).toEqual({ class: "non-idempotent" });
  });
});

/**
 * Phase 2 adapter tests for createAppBuildAdapter.
 *
 * Covers:
 *   - cli-subprocess strategy spawns the right subprocess function per
 *     provider (mock cliRunner, assert provider passed).
 *   - cli-subprocess strategy emits stream chunks from `tool_progress`
 *     events and surfaces a `message_finalized` with APP_READY: <url>.
 *   - cli-subprocess strategy's APP_READY: <url> parsing pulls the URL
 *     into providerState so soak metrics / op-result inspection see it.
 *   - in-canonical-sub-agent strategy returns the user's provider
 *     adapter (no subprocess spawn) — we inject providerAdapterFactory
 *     and assert it's invoked with the persona system prompt.
 *   - abort() flips the adapter's `aborted` flag and a runTurn that
 *     started post-abort returns a clean error report rather than
 *     spawning the subprocess.
 */
import { describe, it, expect } from "vitest";
import type { Adapter, AdapterReport, TurnInput } from "../src/canonical-loop/adapter-contract.js";
import {
  createAppBuildAdapter,
  APP_BUILD_ADAPTER_NAME,
  type CliBuildRunner,
} from "../src/canonical-loop/adapters/app-build-adapter.js";

function emptyTurnInput(opId = "op_app_build_test", turnIdx = 0): TurnInput {
  return {
    opId,
    turnIdx,
    messages: [],
    tools: [],
  };
}

function collectReports(): {
  reports: AdapterReport[];
  report: (r: AdapterReport) => void;
} {
  const reports: AdapterReport[] = [];
  return { reports, report: (r) => { reports.push(r); } };
}

describe("createAppBuildAdapter — cli-subprocess strategy", () => {
  it("codex provider routes to the codex subprocess branch of the runner", async () => {
    const calls: Array<{ provider: string; prompt: string }> = [];
    const cliRunner: CliBuildRunner = async (input) => {
      calls.push({ provider: input.provider, prompt: input.prompt });
      return { content: `APP_READY: ${input.appUrl}` };
    };
    const adapter = await createAppBuildAdapter({
      strategy: "cli-subprocess",
      provider: "codex",
      appName: "x",
      appDir: "/tmp/x",
      appUrl: "http://localhost/x",
      prompt: "PROMPT-CODEX",
      systemPrompt: "PERSONA",
      cliRunner,
    });
    const { report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);
    expect(calls).toHaveLength(1);
    expect(calls[0].provider).toBe("codex");
    expect(calls[0].prompt).toBe("PROMPT-CODEX");
    expect(result.terminalReason).toBe("done");
  });

  it("anthropic provider routes to the claude subprocess branch of the runner", async () => {
    const calls: string[] = [];
    const cliRunner: CliBuildRunner = async (input) => {
      calls.push(input.provider);
      return { content: `APP_READY: ${input.appUrl}` };
    };
    const adapter = await createAppBuildAdapter({
      strategy: "cli-subprocess",
      provider: "anthropic",
      appName: "y",
      appDir: "/tmp/y",
      appUrl: "http://localhost/y",
      prompt: "PROMPT-CLAUDE",
      systemPrompt: "PERSONA",
      cliRunner,
    });
    const { report } = collectReports();
    await adapter.runTurn(emptyTurnInput(), report);
    expect(calls).toEqual(["anthropic"]);
  });

  it("forwards tool_progress lines from the runner as stream_chunk reports", async () => {
    const cliRunner: CliBuildRunner = async ({ onEvent, appUrl }) => {
      onEvent?.({ type: "tool_progress", toolName: "build_app", message: "Reading…" });
      onEvent?.({ type: "tool_progress", toolName: "build_app", message: "Writing index.html…" });
      return { content: `APP_READY: ${appUrl}` };
    };
    const adapter = await createAppBuildAdapter({
      strategy: "cli-subprocess",
      provider: "codex",
      appName: "z",
      appDir: "/tmp/z",
      appUrl: "http://localhost/z",
      prompt: "P",
      systemPrompt: "P",
      cliRunner,
    });
    const { reports, report } = collectReports();
    await adapter.runTurn(emptyTurnInput(), report);
    const chunks = reports.filter(r => r.kind === "stream_chunk");
    expect(chunks.length).toBe(2);
    const finalized = reports.find(r => r.kind === "message_finalized");
    expect(finalized).toBeDefined();
  });

  it("extracts APP_READY: <url> into providerState.providerPayload.url", async () => {
    const cliRunner: CliBuildRunner = async () => ({
      content: "Build went fine.\nAPP_READY: http://example.test/apps/foo/index.html\nthx",
    });
    const adapter = await createAppBuildAdapter({
      strategy: "cli-subprocess",
      provider: "codex",
      appName: "foo",
      appDir: "/tmp/foo",
      appUrl: "http://placeholder/should-be-replaced",
      prompt: "P",
      systemPrompt: "P",
      cliRunner,
    });
    const { report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);
    expect(result.providerState.adapterName).toBe(APP_BUILD_ADAPTER_NAME);
    const payload = result.providerState.providerPayload as Record<string, unknown>;
    expect(payload.url).toBe("http://example.test/apps/foo/index.html");
    expect(payload.strategy).toBe("cli-subprocess");
    expect(payload.provider).toBe("codex");
    expect(result.terminalReason).toBe("done");
  });

  it("runner returning isError=true surfaces an error report + terminalReason='error'", async () => {
    const cliRunner: CliBuildRunner = async () => ({
      content: "Codex CLI exit code 0 but no index.html",
      isError: true,
    });
    const adapter = await createAppBuildAdapter({
      strategy: "cli-subprocess",
      provider: "codex",
      appName: "bad",
      appDir: "/tmp/bad",
      appUrl: "http://localhost/bad",
      prompt: "P",
      systemPrompt: "P",
      cliRunner,
    });
    const { reports, report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);
    expect(result.terminalReason).toBe("error");
    const errs = reports.filter(r => r.kind === "error");
    expect(errs.length).toBeGreaterThan(0);
  });

  it("runner throwing converts to an error report rather than throwing out of runTurn", async () => {
    const cliRunner: CliBuildRunner = async () => {
      throw new Error("codex CLI not installed");
    };
    const adapter = await createAppBuildAdapter({
      strategy: "cli-subprocess",
      provider: "codex",
      appName: "throw",
      appDir: "/tmp/throw",
      appUrl: "http://localhost/throw",
      prompt: "P",
      systemPrompt: "P",
      cliRunner,
    });
    const { reports, report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);
    expect(result.terminalReason).toBe("error");
    const errs = reports.filter(r => r.kind === "error");
    expect(errs[0]).toMatchObject({ kind: "error", code: "build_failed" });
  });

  it("abort() before runTurn returns an aborted error without invoking the runner", async () => {
    let runnerCalls = 0;
    const cliRunner: CliBuildRunner = async () => {
      runnerCalls++;
      return { content: "" };
    };
    const adapter = await createAppBuildAdapter({
      strategy: "cli-subprocess",
      provider: "codex",
      appName: "a",
      appDir: "/tmp/a",
      appUrl: "http://localhost/a",
      prompt: "P",
      systemPrompt: "P",
      cliRunner,
    });
    await adapter.abort();
    const { reports, report } = collectReports();
    const result = await adapter.runTurn(emptyTurnInput(), report);
    expect(runnerCalls).toBe(0);
    expect(result.terminalReason).toBe("error");
    expect(reports.some(r => r.kind === "error" && r.code === "aborted")).toBe(true);
  });
});

describe("createAppBuildAdapter — in-canonical-sub-agent strategy", () => {
  it("delegates to the provider adapter factory with the persona system prompt", async () => {
    const factoryCalls: Array<{ provider: string; systemPrompt: string }> = [];
    const stubAdapter: Adapter = {
      name: "stub",
      version: "1.0.0",
      runTurn: async () => ({
        providerState: { adapterName: "stub", adapterVersion: "1.0.0", providerPayload: {} },
        terminalReason: "done",
      }),
      abort: async () => { /* no-op */ },
    };
    const adapter = await createAppBuildAdapter({
      strategy: "in-canonical-sub-agent",
      provider: "qwen",
      appName: "n",
      appDir: "/tmp/n",
      appUrl: "http://localhost/n",
      prompt: "PROMPT-IGNORED",
      systemPrompt: "PERSONA-PROMPT",
      providerAdapterFactory: async (provider, opts) => {
        factoryCalls.push({ provider, systemPrompt: opts.systemPrompt });
        return stubAdapter;
      },
    });
    expect(adapter).toBe(stubAdapter);
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].provider).toBe("qwen");
    expect(factoryCalls[0].systemPrompt).toBe("PERSONA-PROMPT");
  });

  it("does NOT spawn a subprocess on the in-canonical path", async () => {
    let cliCalled = false;
    const cliRunner: CliBuildRunner = async () => {
      cliCalled = true;
      return { content: "" };
    };
    const stubAdapter: Adapter = {
      name: "stub",
      version: "1.0.0",
      runTurn: async () => ({
        providerState: { adapterName: "stub", adapterVersion: "1.0.0", providerPayload: {} },
        terminalReason: "done",
      }),
      abort: async () => { /* no-op */ },
    };
    const adapter = await createAppBuildAdapter({
      strategy: "in-canonical-sub-agent",
      provider: "cerebras",
      appName: "m",
      appDir: "/tmp/m",
      appUrl: "http://localhost/m",
      prompt: "P",
      systemPrompt: "P",
      cliRunner,
      providerAdapterFactory: async () => stubAdapter,
    });
    const { report } = collectReports();
    await adapter.runTurn(emptyTurnInput(), report);
    expect(cliCalled).toBe(false);
  });
});

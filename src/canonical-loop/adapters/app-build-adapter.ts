/**
 * App-build adapter — canonical-loop entrypoint for the app_build op type
 * (Phase 2 of docs/migration/build-app-to-canonical-op.md).
 *
 * The factory routes per the app-builder saved-agent template's
 * `providerStrategy`:
 *
 *   - cli-subprocess (codex, anthropic): wraps the legacy
 *     buildWithCodex / buildWithClaude subprocess flow in a one-turn
 *     adapter. Progress lines from the CLI's onEvent callback become
 *     stream chunks; APP_READY emission terminates the turn with
 *     terminalReason="done".
 *
 *   - in-canonical-sub-agent (qwen, cerebras, grok, gemini, local, …):
 *     delegates to the user's selected provider's HTTP adapter so the
 *     loop drives a real turn_loop with the write/read/edit/bash tools.
 *     The persona prompt is the app-builder template's systemPrompt; the
 *     per-build context is pre-seeded as turn-0 op_messages by the
 *     build_app_canonical tool before the worker leases the op.
 *
 * Sandbox boundary (PRD §15): this file is audited by the boundary test
 * in test/canonical-loop-11-boundary-audit.test.ts. It does NOT import
 * `node:child_process` directly — the legacy `buildWithCodex` /
 * `buildWithClaude` functions in `src/tools/builder-tools.ts` own the
 * subprocess primitives behind a regular function call.
 */
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { ProviderStateEnvelope } from "../contract-types.js";
import { createAnthropicAdapter } from "./anthropic.js";

export const APP_BUILD_ADAPTER_NAME = "app_build";
export const APP_BUILD_ADAPTER_VERSION = "1.0.0";

export type AppBuildExecStrategy = "cli-subprocess" | "in-canonical-sub-agent";

export interface AppBuildAdapterOptions {
  strategy: AppBuildExecStrategy;
  /** User-selected provider id — drives subprocess choice for cli-subprocess
   *  and adapter choice for in-canonical-sub-agent. */
  provider: string;
  appName: string;
  appDir: string;
  appUrl: string;
  /** Fully-rendered builder prompt — fed verbatim to the CLI subprocess
   *  (cli-subprocess strategy). Ignored on the in-canonical path, which
   *  reads its per-build user message from op_messages. */
  prompt: string;
  /** Persona prompt for the in-canonical-sub-agent strategy (renderPersonaPrompt). */
  systemPrompt: string;
  sessionId?: string;
  /** Optional model override. When omitted, each provider's adapter picks
   *  its own default. */
  model?: string;
  /** Test seam: override the CLI runner so unit tests don't spawn real
   *  subprocesses. Production passes nothing — the default runner calls
   *  through to builder-tools.ts. */
  cliRunner?: CliBuildRunner;
  /** Test seam: override provider-adapter construction for in-canonical
   *  strategy tests. Production passes nothing. */
  providerAdapterFactory?: (provider: string, opts: ProviderAdapterFactoryOptions) => Promise<Adapter>;
}

export interface ProviderAdapterFactoryOptions {
  systemPrompt: string;
  sessionId?: string;
  model?: string;
}

export interface CliBuildRunnerInput {
  provider: "codex" | "anthropic";
  prompt: string;
  appDir: string;
  appUrl: string;
  onEvent?: (e: { type: string; [k: string]: unknown }) => void;
}

export interface CliBuildRunnerResult {
  content: string;
  isError?: boolean;
}

export type CliBuildRunner = (input: CliBuildRunnerInput) => Promise<CliBuildRunnerResult>;

export async function createAppBuildAdapter(opts: AppBuildAdapterOptions): Promise<Adapter> {
  if (opts.strategy === "cli-subprocess") {
    return new CliBuildAdapter(opts);
  }
  const factory = opts.providerAdapterFactory ?? defaultProviderAdapterFactory;
  return factory(opts.provider, {
    systemPrompt: opts.systemPrompt,
    sessionId: opts.sessionId,
    model: opts.model,
  });
}

class CliBuildAdapter implements Adapter {
  readonly name = APP_BUILD_ADAPTER_NAME;
  readonly version = APP_BUILD_ADAPTER_VERSION;

  private aborted = false;

  constructor(private readonly opts: AppBuildAdapterOptions) {}

  async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
    if (this.aborted) {
      report({ kind: "error", code: "aborted", message: "adapter aborted before runTurn", retryable: false });
      return { providerState: this.buildProviderState({ aborted: true }), terminalReason: "error" };
    }

    const subprocessProvider: "codex" | "anthropic" =
      this.opts.provider === "codex" ? "codex" : "anthropic";

    const onEvent = (e: { type: string; message?: unknown; [k: string]: unknown }): void => {
      if (this.aborted) return;
      if (e.type !== "tool_progress") return;
      const message = typeof e.message === "string" ? e.message : "";
      if (!message) return;
      report({ kind: "stream_chunk", body: { delta: message + "\n" } });
    };

    const runner = this.opts.cliRunner ?? defaultCliRunner;

    let result: CliBuildRunnerResult;
    try {
      result = await runner({
        provider: subprocessProvider,
        prompt: this.opts.prompt,
        appDir: this.opts.appDir,
        appUrl: this.opts.appUrl,
        onEvent,
      });
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      report({ kind: "error", code: "build_failed", message, retryable: false });
      return { providerState: this.buildProviderState({ error: message }), terminalReason: "error" };
    }

    if (this.aborted) {
      report({ kind: "error", code: "aborted", message: "adapter aborted mid-build", retryable: false });
      return { providerState: this.buildProviderState({ aborted: true }), terminalReason: "error" };
    }

    const content = result.content ?? "";
    const urlMatch = content.match(/APP_READY:\s*(\S+)/);
    const url = urlMatch ? urlMatch[1] : this.opts.appUrl;
    const finalText = content.length > 0
      ? (content.includes("APP_READY") ? content : `${content}\n\nAPP_READY: ${url}`)
      : `APP_READY: ${url}`;

    report({
      kind: "message_finalized",
      message: {
        messageId: `am-${input.opId}-${input.turnIdx}-build-${result.isError ? "error" : "done"}`,
        role: "assistant",
        content: { text: finalText },
      },
    });

    if (result.isError) {
      report({ kind: "error", code: "build_error", message: content.slice(0, 500), retryable: false });
      return {
        providerState: this.buildProviderState({ stopReason: "build_error" }),
        terminalReason: "error",
      };
    }

    return {
      providerState: this.buildProviderState({ url, stopReason: "app_ready", provider: subprocessProvider }),
      terminalReason: "done",
    };
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  private buildProviderState(payload: Record<string, unknown>): ProviderStateEnvelope {
    return {
      adapterName: APP_BUILD_ADAPTER_NAME,
      adapterVersion: APP_BUILD_ADAPTER_VERSION,
      providerPayload: {
        strategy: this.opts.strategy,
        provider: this.opts.provider,
        appName: this.opts.appName,
        ...payload,
      },
    };
  }
}

const defaultCliRunner: CliBuildRunner = async (input) => {
  const { buildWithCodex, buildWithClaude } = await import("../../tools/builder-tools.js");
  const out = input.provider === "codex"
    ? await buildWithCodex(input.prompt, input.appDir, input.appUrl, input.onEvent)
    : await buildWithClaude(input.prompt, input.appDir, input.appUrl, input.onEvent);
  return { content: out.content, isError: out.isError };
};

async function defaultProviderAdapterFactory(
  provider: string,
  opts: ProviderAdapterFactoryOptions,
): Promise<Adapter> {
  if (provider === "anthropic") {
    return createAnthropicAdapter({
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      sessionId: opts.sessionId,
    });
  }
  if (provider === "codex") {
    const { createCodexAdapter } = await import("./codex.js");
    return createCodexAdapter({
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      sessionId: opts.sessionId,
    });
  }
  // openai-compat: qwen / cerebras / grok / gemini / local / openai / xai / custom / ollama-cloud
  const { createOpenAICompatAdapter, resolveOpenAICompatTarget } = await import("./openai-compat.js");
  const { resolveProvider } = await import("../../agent-request/resolve-provider.js");
  const { getRuntimeConfig } = await import("../../config.js");
  const { getSecretsStoreSingleton, SecretsStore } = await import("../../secrets.js");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const dataDir = join(homedir(), ".lax");
  const config = getRuntimeConfig();
  const secrets = getSecretsStoreSingleton() ?? new SecretsStore(dataDir);
  const prepared = await resolveProvider(config, secrets, dataDir, provider);
  let target = await resolveOpenAICompatTarget(prepared.provider, {
    apiKey: prepared.apiKey,
    customBaseURL: prepared.customBaseURL,
  });
  if (prepared.provider === "local") {
    const { isCloudModel, getCloudOllamaCallTarget } = await import("../../ollama-cloud.js");
    if (isCloudModel(opts.model ?? prepared.model)) {
      const cloudTarget = getCloudOllamaCallTarget();
      if (cloudTarget) target = cloudTarget;
    }
  }
  if (!target) {
    throw new Error(`provider ${provider} has no usable OpenAI-compat target — check API key and base URL config`);
  }
  return createOpenAICompatAdapter({
    systemPrompt: opts.systemPrompt,
    model: opts.model ?? prepared.model,
    baseURL: target.baseURL,
    apiKey: target.apiKey,
    temperature: prepared.temperature,
    sessionId: opts.sessionId,
  });
}

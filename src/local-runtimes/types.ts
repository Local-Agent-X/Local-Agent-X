/**
 * Local-runtime seam — contracts only, zero imports.
 *
 * A "local runtime" is an inference server the user runs themselves:
 * Ollama, LM Studio, vLLM, llama.cpp server, etc. This module is the
 * canonical owner of local-runtime DISCOVERY (which runtimes exist,
 * which models they serve, what each model's real limits are).
 *
 * Chat traffic does NOT flow through here — it stays on the canonical
 * OpenAI-compat adapter. Probes only answer questions:
 *   detect      → is something answering at this endpoint, and is it us?
 *   listModels  → what models does it serve?
 *   probeModel  → what is this model's REAL context window / tool support?
 *
 * Every probe method resolves, never throws — unreachable runtimes are
 * a normal state, not an error (mirrors fetchLocalOllamaTags's contract).
 */

export type LocalRuntimeKind = "ollama" | "openai-compat";

export interface LocalRuntimeEndpoint {
  /** Runtime ROOT (no trailing slash, no /v1). e.g. "http://127.0.0.1:11434" */
  baseUrl: string;
  /** "auto" = found by the known-port sweep; "manual" = user-added in settings. */
  origin: "auto" | "manual";
}

export interface LocalModel {
  /** Model id exactly as the runtime's chat endpoint expects it. */
  id: string;
  /**
   * REAL context window in tokens, as loaded/served right now — not the
   * architecture max. null = the runtime wouldn't say. Callers must treat
   * null as unknown, never substitute an optimistic default.
   */
  contextWindow: number | null;
  /** Runtime-declared tool-call support. null = unknown (self-heal decides). */
  tools: boolean | null;
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface LocalRuntimeInfo {
  kind: LocalRuntimeKind;
  /** Stable identity for settings/UI, e.g. "ollama@127.0.0.1:11434". */
  id: string;
  /** Human label: "Ollama", "LM Studio", "vLLM", "llama.cpp", … */
  label: string;
  endpoint: LocalRuntimeEndpoint;
  /**
   * OpenAI-compat chat base (`${baseUrl}/v1`) — the key the registry,
   * chat adapter, and model-capabilities-store all agree on.
   */
  chatBaseUrl: string;
  models: LocalModel[];
  refreshedAt: number;
}

export interface LocalRuntimeProbe {
  readonly kind: LocalRuntimeKind;
  readonly label: string;
  /** Loopback ports this probe claims during the auto-discovery sweep. */
  readonly defaultPorts: readonly number[];

  /** Cheap reachability + identity check. Never throws; unreachable → false. */
  detect(ep: LocalRuntimeEndpoint, signal?: AbortSignal): Promise<boolean>;

  /**
   * Optional product identification for a detected endpoint ("LM Studio",
   * "vLLM", "llama.cpp"). One probe kind can serve many products; the
   * label is per-endpoint. Never throws; unknown → null.
   */
  identify?(ep: LocalRuntimeEndpoint, signal?: AbortSignal): Promise<string | null>;

  /** Never throws; unreachable → []. contextWindow/tools may be null here. */
  listModels(ep: LocalRuntimeEndpoint, signal?: AbortSignal): Promise<LocalModel[]>;

  /** Deep per-model probe (real window, tools). Never throws; unknown → {}. */
  probeModel(
    ep: LocalRuntimeEndpoint,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<Partial<LocalModel>>;

  /**
   * Stable runtime/model identity used only to decide whether a behavioral
   * certification can be reused. Unknown version or digest stays null and
   * makes that result non-reusable. Never throws.
   */
  certificationIdentity?(
    ep: LocalRuntimeEndpoint,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<{ runtimeVersion: string | null; modelDigest: string | null }>;

  /**
   * Runtime-specific extra request body to ask for `tokens` of context on
   * the OpenAI-compat chat path. Return {} when the runtime cannot be told
   * per-request. (Measured 2026-07-15: Ollama's /v1 endpoint silently DROPS
   * options.num_ctx — only its native /api/chat honors it — so the Ollama
   * probe returns {} and LAX reports the real window instead of pretending
   * to resize it.)
   */
  chatExtraBody(modelId: string, tokens: number): Record<string, unknown>;
}

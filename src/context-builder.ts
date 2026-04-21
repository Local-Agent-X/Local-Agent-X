/**
 * Context Builder — modular, ordered system prompt assembly with cache boundary.
 *
 * All entry points (web chat, bridge, cron, sub-agents) use this single builder.
 * Sections above the cache boundary are stable across turns (cacheable by LLM).
 * Sections below are dynamic per request.
 *
 * Pattern borrowed from upstream: static sections are separated from dynamic
 * ones by a cache boundary marker. LLM providers that support prompt caching
 * (Anthropic, OpenAI) can cache the stable prefix and only reprocess the suffix.
 */

export const CACHE_BOUNDARY = "\n<!-- CACHE_BOUNDARY -->\n";

export interface PromptSection {
  id: string;
  label: string;
  type: "static" | "dynamic";
  build: () => string | Promise<string>;
  shouldInclude?: () => boolean;
}

export class ContextBuilder {
  private sections: PromptSection[] = [];

  addSection(section: PromptSection): this {
    this.sections.push(section);
    return this;
  }

  /** Build the full prompt with cache boundary between static and dynamic sections. */
  async build(): Promise<string> {
    const staticParts: string[] = [];
    const dynamicParts: string[] = [];

    for (const section of this.sections) {
      if (section.shouldInclude && !section.shouldInclude()) continue;
      const content = await section.build();
      if (!content) continue;

      if (section.type === "static") {
        staticParts.push(content);
      } else {
        dynamicParts.push(content);
      }
    }

    if (dynamicParts.length > 0) {
      return staticParts.join("") + CACHE_BOUNDARY + dynamicParts.join("");
    }
    return staticParts.join("");
  }

  /** Split a built prompt into cacheable prefix and dynamic suffix. */
  static split(prompt: string): { stablePrefix: string; dynamicSuffix: string } {
    const idx = prompt.indexOf(CACHE_BOUNDARY);
    if (idx === -1) return { stablePrefix: prompt, dynamicSuffix: "" };
    return {
      stablePrefix: prompt.slice(0, idx),
      dynamicSuffix: prompt.slice(idx + CACHE_BOUNDARY.length),
    };
  }

  getSectionOrder(): string[] {
    return this.sections.map(s => s.id);
  }
}

/**
 * Single builder factory for ALL paths — web chat, bridge, cron, sub-agents.
 * Callers pass what they have; empty strings are auto-skipped.
 */
export function createSystemPromptBuilder(opts: {
  basePrompt: string;
  providerHint: string;
  toolPromptSection?: string;
  integrationsContext?: string;
  // Dynamic sections
  contextBlock?: string;
  relevantMemories?: string;
  smartContext?: string;
  memoryContext?: string;
  notificationHint?: string;
  canaryBlock?: string;
  // Bridge-specific
  bridgeContext?: string;
}): ContextBuilder {
  const builder = new ContextBuilder();

  // ── Static sections (cacheable across turns) ──

  builder.addSection({
    id: "core-identity", label: "System Prompt", type: "static",
    build: () => opts.basePrompt,
  });

  // App manifest — the agent's map of its own body
  builder.addSection({
    id: "app-manifest", label: "App Map", type: "static",
    build: () => {
      try {
        const { getManifestSummary } = require("./manifest-generator.js");
        return getManifestSummary() || "";
      } catch { return ""; }
    },
  });

  builder.addSection({
    id: "provider-hint", label: "Provider", type: "static",
    build: () => opts.providerHint,
  });

  if (opts.toolPromptSection) {
    builder.addSection({
      id: "tool-guidance", label: "Tool Guidance", type: "static",
      build: () => opts.toolPromptSection!,
      shouldInclude: () => opts.toolPromptSection!.length > 0,
    });
  }

  if (opts.integrationsContext) {
    builder.addSection({
      id: "integrations", label: "Connected APIs", type: "static",
      build: () => opts.integrationsContext!,
      shouldInclude: () => opts.integrationsContext!.length > 0,
    });
  }

  // ── Dynamic sections (recomputed per request) ──

  if (opts.contextBlock) {
    builder.addSection({
      id: "context-block", label: "Memory Context", type: "dynamic",
      build: () => opts.contextBlock!,
      shouldInclude: () => opts.contextBlock!.length > 0,
    });
  }

  if (opts.relevantMemories) {
    builder.addSection({
      id: "relevant-memories", label: "Relevant Memories", type: "dynamic",
      build: () => opts.relevantMemories!,
      shouldInclude: () => opts.relevantMemories!.length > 0,
    });
  }

  if (opts.smartContext) {
    builder.addSection({
      id: "smart-context", label: "Related Sessions", type: "dynamic",
      build: () => opts.smartContext!,
      shouldInclude: () => opts.smartContext!.length > 0,
    });
  }

  if (opts.memoryContext) {
    builder.addSection({
      id: "memory-orchestrator", label: "Memory Orchestrator", type: "dynamic",
      build: () => opts.memoryContext!,
      shouldInclude: () => opts.memoryContext!.length > 0,
    });
  }

  if (opts.notificationHint) {
    builder.addSection({
      id: "notifications", label: "Notifications", type: "dynamic",
      build: () => opts.notificationHint!,
      shouldInclude: () => opts.notificationHint!.length > 0,
    });
  }

  if (opts.bridgeContext) {
    builder.addSection({
      id: "bridge-context", label: "Bridge Context", type: "dynamic",
      build: () => opts.bridgeContext!,
      shouldInclude: () => opts.bridgeContext!.length > 0,
    });
  }

  if (opts.canaryBlock) {
    builder.addSection({
      id: "canary", label: "Security Canary", type: "dynamic",
      build: () => opts.canaryBlock!,
      shouldInclude: () => opts.canaryBlock!.length > 0,
    });
  }

  return builder;
}

// Keep backward compat for any code importing the old name
export const createChatContextBuilder = createSystemPromptBuilder;

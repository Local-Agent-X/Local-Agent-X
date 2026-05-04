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
  /** Memory dir — when set, the project catalog (apps + entities) is injected. */
  memoryDir?: string;
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

  // App manifest — the agent's map of its own body (auto-generated catalog)
  builder.addSection({
    id: "app-manifest", label: "App Map", type: "static",
    build: () => {
      try {
        const { getManifestSummary } = require("./manifest-generator.js");
        return getManifestSummary() || "";
      } catch { return ""; }
    },
  });

  // AGENTS.md — hand-written invariants and architectural rules. Pairs with
  // the JSON manifest: manifest says WHAT exists, AGENTS.md says what's
  // ALLOWED (three-lane routing, directory boundaries, code limits, protocol
  // invariants). Injected verbatim so the agent reads the canonical rules
  // rather than a drifty paraphrase.
  builder.addSection({
    id: "agents-md", label: "Rules", type: "static",
    build: async () => {
      try {
        const { readFileSync, existsSync } = await import("node:fs");
        const { resolve, join, dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        // Resolve from this file's location to the repo root.
        // dist/context-builder.js → dist/ → repo root.
        const thisFile = fileURLToPath(import.meta.url);
        const root = resolve(dirname(thisFile), "..");
        const p = join(root, "AGENTS.md");
        if (!existsSync(p)) return "";
        const md = readFileSync(p, "utf-8");
        return `## Invariants (AGENTS.md)\n${md}`;
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

  // Memory-recall reflex. Past sessions / built apps / pinned items are
  // NOT auto-injected anymore (cross-session bleed gates landed May 2026).
  // Without this nudge the model defaults to guessing from URLs/names
  // instead of checking what's actually been built or discussed before.
  // Sits in the static section so it's cacheable.
  builder.addSection({
    id: "recall-reflex", label: "Recall Reflex", type: "static",
    build: () => `## Memory-Recall Reflex
When the user references a project, website, person, or topic you don't recognize from THIS conversation — INCLUDING brand/project names you can read from an attached IMAGE:
- Your default reflex is to call \`search_past_sessions\` BEFORE answering.
- Image counts as a reference. If the user attaches a logo and asks "what's this?", the brand name you read from the image IS the search query. Don't just describe the image and stop — search the brand name too.
- Don't guess from a domain name, brand, or visible logo. If you read "Baddies & Sugar Daddies" off an image and the user is asking what it is, search "baddies sugar daddies" or "baddiesandsugardaddies" before answering.
- The tool also surfaces apps you previously built (workspace/apps/<name>/) — read their files if you need actual build details. Cross-reference the Project Catalog above to see if the brand matches a built app slug.
- If the search returns nothing, say so honestly. Don't fabricate "luxury vibe" descriptions from a URL or logo alone — that's the failure mode this reflex prevents.`,
  });

  // Project catalog — static list of the user's known projects/entities so
  // the agent recognizes them by name without needing a tool call. Pairs
  // with the recall reflex above: this section says "these names you
  // already know exist", and the reflex says "search for the details when
  // a known name comes up." Cached for 60s in the catalog module.
  if (opts.memoryDir) {
    builder.addSection({
      id: "project-catalog", label: "Project Catalog", type: "static",
      build: async () => {
        try {
          const { getProjectCatalogSection } = await import("./memory/project-catalog.js");
          return getProjectCatalogSection(opts.memoryDir!);
        } catch { return ""; }
      },
      shouldInclude: () => !!opts.memoryDir,
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

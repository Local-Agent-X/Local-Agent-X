/**
 * Context Builder — modular, ordered system prompt assembly.
 *
 * Currently a structural refactor only: sections are named and ordered
 * but the builder is recreated per request. Cross-request caching is
 * not yet implemented — that requires changing the factory to accept
 * callbacks instead of snapshot strings.
 *
 * Section types are annotated as static/dynamic to guide future caching:
 * - static: could be cached across requests (core identity, tool guidance)
 * - dynamic: must recompute per request (memory, session context, canary)
 */

export interface PromptSection {
  /** Unique identifier for this section */
  id: string;
  /** Display name for debugging */
  label: string;
  /** Static sections are computed once and cached. Dynamic sections recompute per call. */
  type: "static" | "dynamic";
  /** Return the section content. Empty string = section omitted. */
  build: () => string | Promise<string>;
  /** Optional: return false to skip this section entirely */
  shouldInclude?: () => boolean;
}

export class ContextBuilder {
  private sections: PromptSection[] = [];
  private staticCache = new Map<string, string>();

  /** Add a section in order. Sections are concatenated in the order added. */
  addSection(section: PromptSection): this {
    this.sections.push(section);
    return this;
  }

  /** Clear the static cache (call on config reload) */
  invalidateStatic(): void {
    this.staticCache.clear();
  }

  /** Build the full prompt string. Sections concatenated in order. */
  async build(): Promise<string> {
    const parts: string[] = [];

    for (const section of this.sections) {
      // Check shouldInclude
      if (section.shouldInclude && !section.shouldInclude()) continue;

      let content: string;

      if (section.type === "static") {
        // Use cache for static sections
        if (this.staticCache.has(section.id)) {
          content = this.staticCache.get(section.id)!;
        } else {
          content = await section.build();
          this.staticCache.set(section.id, content);
        }
      } else {
        // Always recompute dynamic sections
        content = await section.build();
      }

      if (content) parts.push(content);
    }

    return parts.join("");
  }

  /** Get section IDs in order (for debugging/testing) */
  getSectionOrder(): string[] {
    return this.sections.map((s) => s.id);
  }

  /** Get the number of sections */
  get sectionCount(): number {
    return this.sections.length;
  }
}

/**
 * Create a context builder pre-configured with the standard section order.
 * This produces output identical to the old flat concatenation in chat.ts.
 */
export function createChatContextBuilder(opts: {
  systemPrompt: string;
  providerHint: string;
  toolPromptSection: string;
  contextBlock: string;
  relevantMemories: string;
  smartContext: string;
  memoryContext: string;
  notificationHint: string;
  integrationsContext: string;
  canaryBlock: string;
}): ContextBuilder {
  const builder = new ContextBuilder();

  // Section 1: Core identity (static — only changes on config reload)
  builder.addSection({
    id: "core-identity",
    label: "System Prompt",
    type: "static",
    build: () => opts.systemPrompt,
  });

  // Section 2: Provider hint (static per session)
  builder.addSection({
    id: "provider-hint",
    label: "Provider Info",
    type: "static",
    build: () => opts.providerHint,
  });

  // Section 3: Tool guidance (static — only changes when tools change)
  builder.addSection({
    id: "tool-guidance",
    label: "Tool Best Practices",
    type: "static",
    build: () => opts.toolPromptSection,
    shouldInclude: () => opts.toolPromptSection.length > 0,
  });

  // Section 4: Memory context block (dynamic — changes per session)
  builder.addSection({
    id: "context-block",
    label: "Memory Context",
    type: "dynamic",
    build: () => opts.contextBlock,
    shouldInclude: () => opts.contextBlock.length > 0,
  });

  // Section 5: Relevant memories from search (dynamic — changes per message)
  builder.addSection({
    id: "relevant-memories",
    label: "Relevant Memories",
    type: "dynamic",
    build: () => opts.relevantMemories,
    shouldInclude: () => opts.relevantMemories.length > 0,
  });

  // Section 6: Related past sessions (dynamic)
  builder.addSection({
    id: "smart-context",
    label: "Related Sessions",
    type: "dynamic",
    build: () => opts.smartContext,
    shouldInclude: () => opts.smartContext.length > 0,
  });

  // Section 7: Memory orchestrator output (dynamic)
  builder.addSection({
    id: "memory-orchestrator",
    label: "Memory Orchestrator",
    type: "dynamic",
    build: () => opts.memoryContext,
    shouldInclude: () => opts.memoryContext.length > 0,
  });

  // Section 8: Notification hints (dynamic)
  builder.addSection({
    id: "notifications",
    label: "Notifications",
    type: "dynamic",
    build: () => opts.notificationHint,
    shouldInclude: () => opts.notificationHint.length > 0,
  });

  // Section 9: Integrations context (static — changes on integration connect/disconnect)
  builder.addSection({
    id: "integrations",
    label: "Connected APIs",
    type: "static",
    build: () => opts.integrationsContext,
    shouldInclude: () => opts.integrationsContext.length > 0,
  });

  // Section 10: Security canary (dynamic — unique per session)
  builder.addSection({
    id: "canary",
    label: "Security Canary",
    type: "dynamic",
    build: () => opts.canaryBlock,
    shouldInclude: () => opts.canaryBlock.length > 0,
  });

  return builder;
}

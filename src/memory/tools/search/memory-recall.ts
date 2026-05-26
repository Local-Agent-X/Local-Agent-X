import type { MemoryIndex } from "../../../memory.js";
import type { FactKind, RetainedFact } from "../../types.js";

export function memoryRecallTool(memory: MemoryIndex) {
  return {
    name: "memory_recall",
    description:
      "Recall structured facts about an entity, by time period, or by fact kind. Use for entity-centric queries ('tell me about X'), temporal queries ('what happened last week'), or opinion queries ('what does X prefer').",
    parameters: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: "Entity name/slug to recall facts about",
        },
        kind: {
          type: "string",
          enum: ["world", "experience", "opinion", "observation"],
          description: "Filter by fact kind",
        },
        since: {
          type: "string",
          description: "Recall facts since this date (ISO format)",
        },
        until: {
          type: "string",
          description: "Recall facts until this date (ISO format)",
        },
      },
    },
    async execute(args: Record<string, unknown>) {
      const entity = args.entity ? String(args.entity) : undefined;
      const kind = args.kind as FactKind | undefined;
      const since = args.since ? new Date(String(args.since)) : undefined;
      const until = args.until ? new Date(String(args.until)) : undefined;

      let facts: RetainedFact[] = [];

      if (entity && kind === "opinion") {
        facts = memory.recallOpinions(entity);
      } else if (entity) {
        facts = memory.recallByEntity(entity);
      } else if (kind) {
        facts = memory.recallByKind(kind);
      } else if (since) {
        facts = memory.recallByTime(since, until || undefined);
      } else {
        return { content: "Provide at least one filter: entity, kind, or since." };
      }

      if (facts.length === 0) {
        return { content: "No facts found matching the query." };
      }

      // Agent-initiated recall counts as "this fact mattered enough to look
      // up" — bump last_updated so the hot-score keeps these facts warm in
      // future system-prompt injections. See index-facts-mutate.ts:198-201.
      const ids = facts.map(f => f.id).filter((n): n is number => typeof n === "number");
      if (ids.length > 0) memory.reinforceFacts(ids);

      const formatted = facts
        .map((f, i) => {
          const date = new Date(f.timestamp).toISOString().split("T")[0];
          const conf = f.kind === "opinion" ? ` (c=${f.confidence.toFixed(2)})` : "";
          const ents = f.entities.length > 0 ? ` @${f.entities.join(" @")}` : "";
          return `[${i + 1}] [${f.kind}]${conf}${ents} ${f.content} — ${date} (${f.sourceFile}#L${f.sourceLine})`;
        })
        .join("\n");

      return { content: formatted };
    },
  };
}

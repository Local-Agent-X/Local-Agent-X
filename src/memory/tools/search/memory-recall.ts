import type { MemoryIndex } from "../../../memory/index.js";
import type { FactKind, RetainedFact } from "../../types.js";
import { readDailyLogsInRange, listNearbyDailyLogDates } from "../../daily-log-range.js";

const isoOf = (d: Date): string => d.toISOString().slice(0, 10);

export function memoryRecallTool(memory: MemoryIndex) {
  return {
    name: "memory_recall",
    description:
      "Recall structured facts from the Facts DB by entity, time period, or fact kind. Use when you have a concrete filter — an entity name ('tell me about X'), a date window ('what happened last week' → pass since/until), or a fact kind/opinion ('what does X prefer'). " +
      "This is the tool for CALENDAR-DATE recall ('what did we do on April 7') — pass since/until. " +
      "Siblings: `memory_search` for free-text/keyword lookup when you don't have a clean filter; `search_past_sessions` to recall from PRIOR conversations rather than the structured Facts DB.",
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

      const memDir = (memory as unknown as { memoryDir: string }).memoryDir;
      let facts: RetainedFact[] = [];
      let dailyLogs: ReturnType<typeof readDailyLogsInRange> = [];
      // A date is present → this is a "what did we do on <date>" query, FULL
      // STOP. It must dominate `kind`: Grok/Gemini reflexively tack on
      // kind:"observation" alongside since/until, which used to route the call
      // into recallByKind (kind-filtered facts, date ignored, daily log never
      // read). Entity-scoped recall ("about @Sam") still wins over a date.
      const isDateWindow = !!since && !entity;

      if (entity && kind === "opinion") {
        facts = memory.recallOpinions(entity);
      } else if (entity) {
        facts = memory.recallByEntity(entity);
      } else if (isDateWindow) {
        facts = memory.recallByTime(since!, until || undefined);
        // recallByTime only sees the extracted Facts DB; the day's actual
        // record lives in the daily-log file (2026-04-16.md). Pull those for
        // the range too, so a date that has a log but no date-stamped facts
        // still answers "what did we do on <date>" instead of "no memory".
        dailyLogs = readDailyLogsInRange(memDir, since!, until || undefined);
      } else if (kind) {
        facts = memory.recallByKind(kind);
      } else {
        return { content: "Provide at least one filter: entity, kind, or since." };
      }

      if (facts.length === 0 && dailyLogs.length === 0) {
        if (isDateWindow) {
          // Honest empty answer — the asked day genuinely has no record.
          // Name the nearest days that DO, and forbid confabulation (the
          // failure where a model invents activity for a blank date).
          const label = until
            ? `${isoOf(since!)} – ${isoOf(until)}`
            : isoOf(since!);
          const nearby = listNearbyDailyLogDates(memDir, since!, 12);
          const nearbyMsg = nearby.length
            ? ` Nearby days that DO have records: ${nearby.join(", ")}.`
            : ` No nearby days have records either.`;
          return {
            content:
              `No activity was logged for ${label}.${nearbyMsg} ` +
              `Tell the user plainly that nothing was recorded that day` +
              `${nearby.length ? ", and offer the nearest logged date(s) above" : ""}. ` +
              `Do NOT invent or infer activity for that date.`,
          };
        }
        return { content: "No facts found matching the query." };
      }

      // Agent-initiated recall counts as "this fact mattered enough to look
      // up" — bump last_updated so the hot-score keeps these facts warm in
      // future system-prompt injections. See index-facts-mutate.ts:198-201.
      const ids = facts.map(f => f.id).filter((n): n is number => typeof n === "number");
      if (ids.length > 0) memory.reinforceFacts(ids);

      const sections: string[] = [];

      if (facts.length > 0) {
        const formatted = facts
          .map((f, i) => {
            const date = new Date(f.timestamp).toISOString().split("T")[0];
            const conf = f.kind === "opinion" ? ` (c=${f.confidence.toFixed(2)})` : "";
            const ents = f.entities.length > 0 ? ` @${f.entities.join(" @")}` : "";
            return `[${i + 1}] [${f.kind}]${conf}${ents} ${f.content} — ${date} (${f.sourceFile}#L${f.sourceLine})`;
          })
          .join("\n");
        sections.push(`Retained facts (${facts.length}):\n${formatted}`);
      }

      if (dailyLogs.length > 0) {
        const blocks = dailyLogs
          .map((l) => {
            const more = l.truncated ? ` — truncated, full file via memory_get("${l.date}.md")` : "";
            return `### ${l.date}${more}\n${l.content}`;
          })
          .join("\n\n");
        sections.push(
          `Daily log${dailyLogs.length > 1 ? "s" : ""} for the requested date range:\n${blocks}`,
        );
      }

      return { content: sections.join("\n\n") };
    },
  };
}

import type { MemoryIndex } from "../../../memory/index.js";
import type { FactKind, RetainedFact } from "../../types.js";
import { readDailyLogsInRange, listNearbyDailyLogDates } from "../../daily-log-range.js";
import type { ImportChunkEntry } from "../../import-recall.js";

const isoOf = (d: Date): string => d.toISOString().slice(0, 10);

export function memoryRecallTool(memory: MemoryIndex) {
  return {
    name: "memory_recall",
    description:
      "Recall structured facts from the Facts DB by entity, time period, or fact kind. Use when you have a concrete filter — an entity name ('tell me about X'), a date window ('what happened last week' → pass since/until), or a fact kind/opinion ('what does X prefer'). " +
      "This is the tool for CALENDAR-DATE recall ('what did we do on April 7') — pass since/until. It spans extracted facts, daily-log files, AND imported conversation history (ChatGPT/Claude) for that date. " +
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
      let imports: ImportChunkEntry[] = [];
      // A date is present → this is a "what did we do on <date>" query, FULL
      // STOP. It dominates BOTH entity and kind. Live from Grok: the model
      // tacks on entity:"Peter" (for "what did WE do") AND kind:"experience"
      // alongside since/until — which used to route into recallByEntity /
      // recallByKind (date ignored, daily log never read), so it answered
      // "nothing recorded". The date is the most-specific filter; it wins.
      const isDateWindow = !!since;

      if (isDateWindow) {
        facts = memory.recallByTime(since!, until || undefined);
        // recallByTime only sees the extracted Facts DB; the day's actual
        // record lives in the daily-log file (2026-04-16.md). Pull those for
        // the range too, so a date that has a log but no date-stamped facts
        // still answers "what did we do on <date>" instead of "no memory".
        dailyLogs = readDailyLogsInRange(memDir, since!, until || undefined);
        // Imported history (ChatGPT/Claude) lives in chunks, not facts or
        // daily-log files — so a date the user imported was invisible here and
        // the agent answered "predates our history". Pull imports for the range
        // too; this is the largest body of dated history for most users.
        imports = memory.recallImportsByDate(since!, until || undefined);
      } else if (entity && kind === "opinion") {
        facts = memory.recallOpinions(entity);
      } else if (entity) {
        facts = memory.recallByEntity(entity);
      } else if (kind) {
        facts = memory.recallByKind(kind);
      } else {
        return { content: "Provide at least one filter: entity, kind, or since." };
      }

      if (facts.length === 0 && dailyLogs.length === 0 && imports.length === 0) {
        if (isDateWindow) {
          // Honest empty answer — the asked day genuinely has no record across
          // facts, daily logs, AND imports. Name the nearest days that DO
          // (drawn from BOTH daily logs and imported history, so the nearest
          // dates aren't artificially clamped to the daily-log era), forbid
          // confabulation, and forbid the worse failure: generalizing one empty
          // date into "we have no history that far back".
          const label = until
            ? `${isoOf(since!)} – ${isoOf(until)}`
            : isoOf(since!);
          const nearby = Array.from(
            new Set([
              ...listNearbyDailyLogDates(memDir, since!, 12),
              ...memory.listNearbyImportDates(since!, 12),
            ]),
          ).sort();
          const nearbyMsg = nearby.length
            ? ` Nearby dates that DO have records: ${nearby.join(", ")}.`
            : ` No nearby dates have records either.`;
          return {
            content:
              `No record found for ${label} in facts, daily logs, or imported history.${nearbyMsg} ` +
              `Tell the user plainly that nothing is recorded for that specific date` +
              `${nearby.length ? ", and offer the nearest dated record(s) above" : ""}. ` +
              `Do NOT infer from this single empty date that history "doesn't go back that far" or "predates" what you have — ` +
              `one blank day says nothing about overall coverage. If the user expects content there, widen the search ` +
              `(free-text memory_search across imports) before concluding it's missing. Do NOT invent activity for that date.`,
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
            // Rows written before schema v12 have no persisted origin — omit
            // rather than printing a fabricated one.
            const origin = f.provenance ? `, origin=${f.provenance}` : "";
            return `[${i + 1}] [${f.kind}]${conf}${ents} ${f.content} — ${date} (${f.sourceFile}#L${f.sourceLine}${origin})`;
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

      if (imports.length > 0) {
        const blocks = imports
          .map((e) => {
            const more = e.truncated
              ? ` — truncated, full conversation via memory_get("${e.path}")`
              : "";
            return `### ${e.date} (imported)${more}\n${e.text}`;
          })
          .join("\n\n");
        sections.push(
          `Imported conversation history for the requested date range:\n${blocks}`,
        );
      }

      return { content: sections.join("\n\n") };
    },
  };
}

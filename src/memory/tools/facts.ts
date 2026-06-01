import type { MemoryIndex } from "../../memory/index.js";
import type { FactKind } from "../types.js";
import { displayContent } from "../utils.js";
import { runMemoryGate, MemoryWriteBlocked } from "../write-safely.js";

// Agent-facing single-fact tools. Sit on top of the Facts DB primitives
// (rememberFact / updateFact / forgetFact in index-facts-mutate.ts). Each
// tool maps one user-visible verb to one DB action.

const VALID_KINDS: FactKind[] = ["world", "experience", "opinion", "observation"];

// A single durable fact is one compact line. These tight signals reject a
// multi-fact dump crammed into one `remember` call (one blob = one
// un-queryable mega-fact). Tuned for near-zero false positives: a 1-2
// sentence single-line fact under 400 chars always passes.
function looksLikeMultiFactBlob(content: string): boolean {
  if (content.includes("\n")) return true;
  if (content.length > 400) return true;
  const sentenceBoundaries = content.match(/[.!?](\s|$)/g);
  if (sentenceBoundaries && sentenceBoundaries.length >= 4) return true;
  return false;
}

function formatToolError(prefix: string, result: { error?: string; matches?: number; preview?: string[] }): string {
  let msg = `${prefix}: ${result.error ?? "unknown error"}`;
  if (result.preview && result.preview.length > 0) {
    msg += "\nMatches:\n" + result.preview.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
  }
  return msg;
}

export function createFactsTools(memory: MemoryIndex) {
  return [
    {
      name: "remember",
      description:
        "Save a durable fact to long-term memory. Use whenever you learn something the next session should know — " +
        "user preferences, environment quirks, project conventions, names, decisions, recurring workflows. " +
        "Facts are stored in the indexed Facts DB and injected into future sessions automatically. " +
        "\n\n" +
        "Write ONE compact statement per call, phrased as a complete sentence (not a fragment): " +
        "'User prefers terse responses' not 'terse'. Phrase generally for transfer ('user prefers business-suite-level dashboards') " +
        "not verbatim ('user said use the facebook dashboard'). " +
        "\n\n" +
        "Optional `kind` (default 'observation'): 'world' for objective facts, 'experience' for things that happened, " +
        "'opinion' for preferences/judgments, 'observation' for general statements. " +
        "Mention entities with @-prefix to index them: 'User's wife is @Sam.' " +
        "\n\n" +
        "Don't use for: session task state, ephemeral TODOs, raw conversation excerpts, trivial info, " +
        "scalar identity fields (use memory_set_user_field for Name/Location/Role/Pronouns).",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The fact to remember, as one sentence" },
          kind: {
            type: "string",
            enum: VALID_KINDS,
            description: "Fact category (default 'observation')",
          },
          confidence: {
            type: "number",
            description: "0.0-1.0 confidence in the fact (default 1.0; use < 1.0 only when uncertain)",
          },
        },
        required: ["content"],
      },
      async execute(args: Record<string, unknown>) {
        const content = String(args.content || "").trim();
        if (!content) return { content: "content is required", isError: true };

        const kind = args.kind ? (String(args.kind) as FactKind) : undefined;
        if (kind && !VALID_KINDS.includes(kind)) {
          return { content: `kind must be one of: ${VALID_KINDS.join(", ")}`, isError: true };
        }
        const confidence = args.confidence != null ? Number(args.confidence) : undefined;
        if (confidence !== undefined && (isNaN(confidence) || confidence < 0 || confidence > 1)) {
          return { content: "confidence must be a number between 0 and 1", isError: true };
        }

        // One compact statement per call. A multi-fact blob becomes a single
        // un-queryable mega-fact, so refuse it with a non-terminal retry hint
        // (isError:false → guidance, not a terminal failure) instead of
        // persisting the dump. Nothing is written in this branch.
        if (looksLikeMultiFactBlob(content)) {
          return {
            content:
              "This looks like multiple facts or a long dump. `remember` stores ONE compact statement per call — split it into separate `remember` calls, one fact each. " +
              "The write was NOT applied. Don't claim 'saved!' — nothing persisted yet.",
            isError: false,
          };
        }

        try {
          const gated = runMemoryGate({ content, source: "tool", target: "memory:retain" });
          const result = memory.rememberFact(gated, { kind, confidence });
          if (!result.ok) {
            return { content: formatToolError("remember failed", result), isError: true };
          }
          memory.markDirty();
          const f = result.fact!;
          return { content: `Remembered [${f.kind}, c=${f.confidence}] #${f.id}: ${displayContent(f).slice(0, 80)}` };
        } catch (e) {
          if (e instanceof MemoryWriteBlocked) {
            return { content: `BLOCKED: ${e.reason}`, isError: true };
          }
          throw e;
        }
      },
    },

    {
      name: "update_fact",
      description:
        "Correct a fact already in memory. Finds the existing fact whose content contains `query` (substring match) " +
        "and replaces it with `content`. Old version is preserved as superseded (bitemporal) so history isn't lost. " +
        "\n\n" +
        "Use when the user corrects a previous statement ('actually my wife is @Sam not @Sammy', " +
        "'we switched from postgres to sqlite', 'the deadline moved to Friday'). " +
        "If 0 or multiple facts match the substring, the call refuses — pick a more specific substring.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring of the existing fact to find" },
          content: { type: "string", description: "The corrected fact, as one sentence" },
          kind: { type: "string", enum: VALID_KINDS, description: "Optional new kind (defaults to old fact's kind)" },
          confidence: { type: "number", description: "Optional new confidence" },
        },
        required: ["query", "content"],
      },
      async execute(args: Record<string, unknown>) {
        const query = String(args.query || "").trim();
        const content = String(args.content || "").trim();
        if (!query) return { content: "query is required", isError: true };
        if (!content) return { content: "content is required", isError: true };

        const kind = args.kind ? (String(args.kind) as FactKind) : undefined;
        if (kind && !VALID_KINDS.includes(kind)) {
          return { content: `kind must be one of: ${VALID_KINDS.join(", ")}`, isError: true };
        }
        const confidence = args.confidence != null ? Number(args.confidence) : undefined;

        try {
          const gated = runMemoryGate({ content, source: "tool", target: "memory:retain" });
          const result = memory.updateFact(query, gated, { kind, confidence });
          if (!result.ok) {
            return { content: formatToolError("update_fact failed", result), isError: true };
          }
          memory.markDirty();
          return {
            content: `Updated fact #${result.oldFactId} → #${result.newFactId}: ${displayContent(result.fact!).slice(0, 80)}`,
          };
        } catch (e) {
          if (e instanceof MemoryWriteBlocked) {
            return { content: `BLOCKED: ${e.reason}`, isError: true };
          }
          throw e;
        }
      },
    },

    {
      name: "forget",
      description:
        "Mark a fact as no longer true. Finds the fact whose content contains `query` (substring match) " +
        "and invalidates it (soft delete; preserves history for audit). " +
        "\n\n" +
        "Use when the user says a fact is wrong, outdated, or shouldn't be remembered. " +
        "If 0 or multiple facts match, the call refuses — pick a more specific substring.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring of the fact to forget" },
        },
        required: ["query"],
      },
      async execute(args: Record<string, unknown>) {
        const query = String(args.query || "").trim();
        if (!query) return { content: "query is required", isError: true };
        const result = memory.forgetFact(query);
        if (!result.ok) {
          return { content: formatToolError("forget failed", result), isError: true };
        }
        memory.markDirty();
        return { content: `Forgot fact #${result.oldFactId}: ${displayContent(result.fact!).slice(0, 80)}` };
      },
    },
  ];
}

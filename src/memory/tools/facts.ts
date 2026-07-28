import type { MemoryIndex } from "../../memory/index.js";
import type { FactKind } from "../types.js";
import { displayContent } from "../utils.js";
import { looksLikeMultiFactBlob, normalizeFactLine, splitMultiFactBlob } from "../fact-split.js";
import { saveFactsBatch } from "./facts-batch.js";
import { runMemoryGate, MemoryWriteBlocked } from "../write-safely.js";
import {
  joinFactsForPromotion,
  promotionContextFromToolArgs,
  splitBatchPromotionContext,
  CLEAN_SELF_SOURCE_SUFFIX,
  TAINTED_SOURCE_SUFFIX,
} from "../promotion-gate.js";
import type { MemoryPromotionContext } from "../promotion-gate.js";

// Agent-facing fact tools. Sit on top of the Facts DB primitives
// (rememberFact / updateFact / forgetFact in index-facts-mutate.ts, plus
// the bulk retain path via fact-split.ts for batched `remember` calls).
// Each tool maps one user-visible verb to the canonical DB write path.

const VALID_KINDS: FactKind[] = ["world", "experience", "opinion", "observation"];
const VALID_PROVENANCE = ["user_statement", "tool_observation", "inference"] as const;
type FactProvenance = typeof VALID_PROVENANCE[number];

const PROVENANCE_CONFIDENCE_CAP: Record<FactProvenance, number> = {
  user_statement: 1.0,
  tool_observation: 0.6,
  inference: 0.6,
};

function parseProvenance(value: unknown): FactProvenance {
  const provenance = String(value || "inference") as FactProvenance;
  return VALID_PROVENANCE.includes(provenance) ? provenance : "inference";
}

function groundedConfidence(
  provenance: FactProvenance,
  requested: number | undefined,
): number {
  return Math.min(requested ?? PROVENANCE_CONFIDENCE_CAP[provenance], PROVENANCE_CONFIDENCE_CAP[provenance]);
}

function provenanceSource(provenance: FactProvenance): string {
  if (provenance === "tool_observation") return "agent-tool:model-declared-tool-observation";
  return `agent-tool:${provenance.replace("_", "-")}`;
}

function authorizedSource(provenance: FactProvenance, promotion: MemoryPromotionContext): string {
  if (promotion.origin === "user_statement") return "agent-tool:user-statement";
  // Tainted-session save: checked BEFORE the tool-observation branch so a
  // tainted "tool observation" cannot shed the label. The prefix is what
  // recall keys its untrusted rendering off — losing it here would launder.
  if (promotion.source?.includes(TAINTED_SOURCE_SUFFIX)) {
    return `agent-tool:tainted-external-${provenance.replace("_", "-")}`;
  }
  if (provenance === "tool_observation") return provenanceSource(provenance);
  // Clean-session auto-allowed (no human click) vs interactively human-approved:
  // the audit label must not claim approval that never happened.
  const grant = promotion.source?.endsWith(CLEAN_SELF_SOURCE_SUFFIX) ? "auto-model-clean" : "approved-model-declared";
  return `agent-tool:${grant}-${provenance.replace("_", "-")}`;
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
        "Write ONE compact statement per fact, phrased as a complete sentence (not a fragment): " +
        "'User prefers terse responses' not 'terse'. Phrase generally for transfer ('user prefers business-suite-level dashboards') " +
        "not verbatim ('user said use the facebook dashboard'). " +
        "Multiple new facts → ONE call with `facts[]` (never one call per fact); " +
        "each is stored as a separate fact, and kind/confidence/provenance apply to all of them. " +
        "\n\n" +
        "Optional `kind` (default 'observation'): 'world' for objective facts, 'experience' for things that happened, " +
        "'opinion' for preferences/judgments, 'observation' for general statements. " +
        "Mention entities with @-prefix to index them: 'User's wife is @Sam.' " +
        "Always set `provenance`: `user_statement` only for something the user directly said, " +
        "`tool_observation` only for a successful tool result, or `inference` for any interpretation. " +
        "This argument is model-declared and does not itself verify a tool execution; tool observations remain unverified. " +
        "Inferences are confidence-capped and must preserve uncertainty; never upgrade suggested/recommended " +
        "language into happened/enforced/current language. " +
        "\n\n" +
        "Don't use for: session task state, ephemeral TODOs, raw conversation excerpts, trivial info, " +
        "scalar identity fields (use memory_set_user_field for Name/Location/Role/Pronouns).",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The fact to remember, as one sentence (provide either this or facts, not both)" },
          facts: {
            type: "array",
            items: { type: "string" },
            description: "Batch save: several facts in ONE call, each item one compact sentence (same constraints as content)",
          },
          kind: {
            type: "string",
            enum: VALID_KINDS,
            description: "Fact category (default 'observation')",
          },
          confidence: {
            type: "number",
            description: "0.0-1.0 confidence; model-declared inference and tool observation are capped at 0.6",
          },
          provenance: {
            type: "string",
            enum: VALID_PROVENANCE,
            description: "Evidence origin. Defaults to inference, never to verified fact.",
          },
        },
        // Exactly one of content/facts — enforced in execute (JSON Schema
        // exactly-one-of is not expressible in this flat tool-schema shape).
        required: [],
      },
      async execute(args: Record<string, unknown>) {
        const content = String(args.content || "").trim();
        // Normalized exactly like joinFactsForPromotion normalizes each item,
        // so the items here, the stamped string, the facts derived from it,
        // and the rows that land are all the same N strings.
        const factsArg = Array.isArray(args.facts)
          ? (args.facts as unknown[]).map((f) => normalizeFactLine(f as string)).filter(Boolean)
          : undefined;
        if (content && factsArg?.length) {
          return { content: "pass either content or facts[], not both", isError: true };
        }
        if (!content && !factsArg?.length) return { content: "content is required", isError: true };

        const kind = args.kind ? (String(args.kind) as FactKind) : undefined;
        if (kind && !VALID_KINDS.includes(kind)) {
          return { content: `kind must be one of: ${VALID_KINDS.join(", ")}`, isError: true };
        }
        const requestedConfidence = args.confidence != null ? Number(args.confidence) : undefined;
        if (requestedConfidence !== undefined && (isNaN(requestedConfidence) || requestedConfidence < 0 || requestedConfidence > 1)) {
          return { content: "confidence must be a number between 0 and 1", isError: true };
        }
        const provenance = parseProvenance(args.provenance);
        const confidence = groundedConfidence(provenance, requestedConfidence);

        // The exact string the dispatch approval phase stamped the promotion
        // capability over (describeMemoryPromotionRequest reads args.content;
        // a facts[] batch is normalized through the shared join helper).
        const stampedContent = content || joinFactsForPromotion(args.facts as unknown[]);
        // One round trip, zero retries: a batched call — facts[] or a
        // multi-fact blob in content — is split in code and saved fact by
        // fact. The old "split it and retry" hint cost a full inference
        // round trip per fact. facts[] items are taken as declared (never
        // sentence-split); only an undeclared blob is split further.
        const atomicFacts =
          factsArg ?? (looksLikeMultiFactBlob(content) ? splitMultiFactBlob(content) : [content]);
        if (atomicFacts.length === 0) return { content: "content is required", isError: true };

        try {
          const target = "memory:retain";
          const promotion = promotionContextFromToolArgs(args, {
            content: stampedContent,
            source: "model-tool:remember",
            target,
            sessionId: String(args._sessionId || "default"),
          });
          if (!promotion.capability) {
            return {
              content: "BLOCKED: memory write arrived at the sink without its promotion capability — the approval-phase stamp was lost in dispatch (plumbing bug, not a policy denial)",
              isError: true,
            };
          }
          if (promotion.provenance !== `model-declared:${provenance}` || promotion.confidence !== confidence) {
            return { content: "BLOCKED: approved provenance/confidence does not match this fact", isError: true };
          }
          if (atomicFacts.length === 1) {
            const gated = runMemoryGate({
              content: atomicFacts[0],
              source: "tool",
              target,
              promotion,
            });
            const result = memory.rememberFact(gated, {
              kind,
              confidence,
              sourceFile: authorizedSource(provenance, promotion),
              promotion,
            });
            if (!result.ok) {
              return { content: formatToolError("remember failed", result), isError: true };
            }
            memory.markDirty();
            const f = result.fact!;
            if (result.indexFailed) {
              return {
                content:
                  `Fact #${f.id} saved but keyword index failed (recall may not find it): ${result.indexError ?? "facts_fts insert error"}`,
                isError: true,
              };
            }
            return {
              content: `Remembered [${f.kind}, c=${f.confidence}, provenance=${provenance}] #${f.id}: ${displayContent(f).slice(0, 80)}`,
            };
          }
          // Batch: derive per-fact capabilities from the ONE stamped parent
          // (consumed exactly once, same as the single path; the atomic facts
          // are re-split from the STAMPED text, never taken from later args),
          // then run each through the canonical single-fact sink. The report
          // never claims more than landed — partial success lists each
          // saved / blocked / skipped fact on its own line.
          const derived = splitBatchPromotionContext(promotion, factsArg !== undefined);
          const results = saveFactsBatch(memory, derived.facts, derived.contexts, {
            kind,
            confidence,
            sourceFile: authorizedSource(provenance, promotion),
            target,
          });
          const savedCount = results.filter((r) => r.status === "saved").length;
          if (savedCount > 0) memory.markDirty();
          const lines = results.map((r) =>
            r.status === "saved"
              ? `SAVED ${r.detail}`
              : r.status === "blocked"
                ? `BLOCKED (${r.detail}): ${r.fact.slice(0, 80)}`
                : `NOT SAVED (${r.detail}): ${r.fact.slice(0, 80)}`,
          );
          return {
            content:
              `Remembered ${savedCount}/${results.length} facts [${kind ?? "observation"}, c=${confidence}, provenance=${provenance}]:\n` +
              lines.join("\n"),
            isError: savedCount === 0,
          };
        } catch (e) {
          if (e instanceof MemoryWriteBlocked) {
            return { content: `BLOCKED: ${e.reason}`, isError: true };
          }
          if ((e as Error).message.includes("memory promotion capability")) {
            return { content: `BLOCKED: ${(e as Error).message}`, isError: true };
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
        "Set provenance to the evidence for the replacement; omitted provenance is treated as inference. " +
        "If 0 or multiple facts match the substring, the call refuses — pick a more specific substring.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring of the existing fact to find" },
          content: { type: "string", description: "The corrected fact, as one sentence" },
          kind: { type: "string", enum: VALID_KINDS, description: "Optional new kind (defaults to old fact's kind)" },
          confidence: { type: "number", description: "Optional new confidence" },
          provenance: {
            type: "string",
            enum: VALID_PROVENANCE,
            description: "Evidence origin for the replacement. Defaults to inference.",
          },
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
        const requestedConfidence = args.confidence != null ? Number(args.confidence) : undefined;
        if (requestedConfidence !== undefined && (isNaN(requestedConfidence) || requestedConfidence < 0 || requestedConfidence > 1)) {
          return { content: "confidence must be a number between 0 and 1", isError: true };
        }
        const provenance = parseProvenance(args.provenance);
        const confidence = groundedConfidence(provenance, requestedConfidence);

        try {
          const target = `memory:update:${query}`;
          const promotion = promotionContextFromToolArgs(args, {
            content,
            source: "model-tool:update_fact",
            target,
            sessionId: String(args._sessionId || "default"),
          });
          if (!promotion.capability) {
            return {
              content: "BLOCKED: memory write arrived at the sink without its promotion capability — the approval-phase stamp was lost in dispatch (plumbing bug, not a policy denial)",
              isError: true,
            };
          }
          if (promotion.provenance !== `model-declared:${provenance}` || promotion.confidence !== confidence) {
            return { content: "BLOCKED: approved provenance/confidence does not match this fact", isError: true };
          }
          const gated = runMemoryGate({
            content,
            source: "tool",
            target,
            promotion,
          });
          const result = memory.updateFact(query, gated, {
            kind,
            confidence,
            sourceFile: authorizedSource(provenance, promotion),
            promotion,
          });
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
          if ((e as Error).message.includes("memory promotion capability")) {
            return { content: `BLOCKED: ${(e as Error).message}`, isError: true };
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
        "If 0 or multiple facts match, the call refuses — pick a more specific substring. " +
        "\n\n" +
        "Scope: ONE retained fact, reversibly. To delete imported chunks, an entire conversation, or to bulk-scrub a term from profile files + daily logs, use `memory_forget` instead (heavier, hard-delete).",
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

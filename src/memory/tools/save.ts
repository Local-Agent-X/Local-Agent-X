import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "../../memory.js";
import { PERSONALITY_FILES, dedupeProfileMarkdown } from "../personality.js";
import {
  writeMemorySafely,
  writeMindFileSafely,
  appendToDailyLogSafely,
  runMemoryGate,
  MemoryWriteBlocked,
} from "../write-safely.js";

export function createSaveTools(memory: MemoryIndex) {
  return [
    {
      name: "memory_save",
      description:
        "Save important information to long-term memory. Targets: 'daily' (conversation log), 'memory' (curated MIND.md facts), 'retain' (structured fact with type/entity/confidence for the Retain system).",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The information to remember" },
          target: {
            type: "string",
            enum: ["daily", "memory", "retain"],
            description:
              "'daily' for daily log (default), 'memory' for MIND.md, 'retain' for structured fact",
          },
        },
        required: ["content"],
      },
      async execute(args: Record<string, unknown>) {
        const rawContent = String(args.content || "");
        const target = String(args.target || "daily");
        const sessionId = args._sessionId ? String(args._sessionId) : undefined;

        if (!rawContent.trim()) {
          return { content: "Nothing to save.", isError: true };
        }

        try {
          if (target === "memory") {
            const existing = memory.readMemoryFile();
            writeMindFileSafely({
              memory,
              source: "tool",
              content: existing + (existing ? "\n\n" : "") + rawContent,
            });
            return { content: "Saved to MIND.md" };
          } else if (target === "retain") {
            // Retain stores facts in the DB. Gate-only — no file write.
            const gated = runMemoryGate({
              content: rawContent,
              source: "tool",
              target: "memory:retain",
            });
            const facts = memory.retain(gated, "agent-tool");
            if (facts.length === 0) {
              const facts2 = memory.retain(`- S ${gated}`, "agent-tool");
              return {
                content: `Retained ${facts2.length} fact(s) as observation`,
              };
            }
            return {
              content: `Retained ${facts.length} fact(s): ${facts.map((f) => `[${f.kind}] ${f.content.slice(0, 60)}`).join("; ")}`,
            };
          } else {
            appendToDailyLogSafely({
              memory,
              source: "tool",
              content: rawContent,
              sessionId,
            });
            return {
              content: `Saved to daily log (${new Date().toISOString().split("T")[0]})`,
            };
          }
        } catch (e) {
          if (e instanceof MemoryWriteBlocked) {
            return { content: `BLOCKED: ${e.reason}`, isError: true };
          }
          throw e;
        }
      },
    },

    {
      name: "memory_update_profile",
      description:
        "Persist a durable preference, workflow rule, or fact you just learned about the user. " +
        "Call this WHENEVER a turn revealed something the next session (or a different provider) " +
        "should know — preferences ('always', 'never', 'I prefer'), corrections ('that's not how I want it'), " +
        "workflow rules ('first do X, then Y'), or relationship/business facts. Don't wait for a curator. " +
        "Files: 'user' (USER.md — preferences, workflow, communication style — bounded ~2000 chars), " +
        "'mind' or 'memory' (MIND.md — facts, projects, accumulated knowledge — bounded ~5000 chars), " +
        "'heart' (HEART.md — your personality), 'identity' (IDENTITY.md — your name/vibe). " +
        "Prefer action='replace_section' over 'append'. For SCALAR fields like Name/Location/Job, action MUST be 'replace_section' with section_heading set to the parent block ('About Me' for USER.md, 'Agent Identity' for IDENTITY.md) — never 'append' for scalar edits, that creates duplicate blocks the next turn has to untangle. " +
        "Phrase entries GENERALLY ('user prefers business-suite-level dashboards for analytics across Meta properties') " +
        "rather than verbatim ('user said use facebook dashboard') so the rule transfers across future tasks.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            enum: ["user", "heart", "identity", "mind", "memory"],
            description: "Which profile file to update",
          },
          action: {
            type: "string",
            enum: ["replace_section", "append", "full_replace"],
            description:
              "'replace_section' to find and replace a section by heading, 'append' to add at the end, 'full_replace' to overwrite the entire file",
          },
          section_heading: {
            type: "string",
            description:
              "For replace_section: the ## heading to find (e.g. 'Family & People')",
          },
          content: {
            type: "string",
            description: "The new content to write",
          },
        },
        required: ["file", "action", "content"],
      },
      async execute(args: Record<string, unknown>) {
        const fileKey = String(args.file || "") as keyof typeof PERSONALITY_FILES;
        const action = String(args.action || "append");
        const newContent = String(args.content || "");

        if (!newContent.trim()) {
          return { content: "Nothing to write.", isError: true };
        }

        const filename = PERSONALITY_FILES[fileKey];
        if (!filename) {
          return {
            content: `Unknown file: ${fileKey}. Use: user, heart, identity, mind, or memory`,
            isError: true,
          };
        }

        const filePath = join(memory["memoryDir"], filename);
        const existing = existsSync(filePath)
          ? readFileSync(filePath, "utf-8")
          : "";

        let updated: string;

        if (action === "full_replace") {
          // Safety: require minimum content length to prevent accidental wipe
          if (newContent.trim().length < 20) {
            return {
              content:
                "full_replace requires at least 20 characters of content to prevent accidental wipe.",
              isError: true,
            };
          }
          // Backup the existing file before full replace. Existing content was
          // already gated on its way in, but treat .bak like every other
          // memory write so the funnel has no exceptions.
          if (existing.trim()) {
            const backupPath = filePath + ".bak";
            try {
              writeMemorySafely({
                content: existing,
                source: "tool",
                target: backupPath,
                mode: "overwrite",
              });
            } catch {}
          }
          updated = newContent;
        } else if (action === "append") {
          updated = existing + "\n\n" + newContent;
        } else if (action === "replace_section") {
          const heading = String(args.section_heading || "");
          if (!heading) {
            return {
              content: "section_heading required for replace_section",
              isError: true,
            };
          }

          // Find section by heading and replace it
          const headingPattern = new RegExp(
            `(^|\\n)(##?\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*)([\\s\\S]*?)(?=\\n##?\\s|$)`,
            "i"
          );

          const match = existing.match(headingPattern);
          if (match) {
            updated = existing.replace(
              headingPattern,
              `$1$2\n${newContent}`
            );
          } else {
            // Section not found — append as new section
            updated = existing + `\n\n## ${heading}\n${newContent}`;
          }
        } else {
          return { content: `Unknown action: ${action}`, isError: true };
        }

        // Char-limit enforcement (upstream-style). Bounded files are what
        // force the model to consolidate instead of append-forever — without
        // a ceiling, the model treats memory as a dump and never compresses.
        // Limits are generous (USER ~2000, MIND ~5000) but not infinite.
        // 'heart'/'identity' are user-author content with no limit — they're
        // not append targets.
        const PROFILE_CHAR_LIMITS: Record<string, number> = {
          "USER.md": 2000,
          "MIND.md": 5000,
        };
        const limit = PROFILE_CHAR_LIMITS[filename];
        if (limit !== undefined && updated.length > limit) {
          // NOT an error — return as `isError: false` so the model treats
          // it as a retry hint rather than a terminal failure. Live testing
          // showed Codex giving up after one over-limit response when this
          // returned isError:true; treating it as guidance produces the
          // intended retry behavior.
          //
          // Directive guidance: name the existing sections so the model
          // can pick a stale one for replace_section, AND suggest the
          // alternative target (USER vs MIND) so workflow/procedural
          // content can land in the larger file instead.
          const sectionHeadings = Array.from(existing.matchAll(/^##?\s+([^\n]+)/gm))
            .map(m => m[1].trim())
            .slice(0, 12);
          const altTarget = filename === "USER.md" ? "mind" : "user";
          const altFile = filename === "USER.md" ? "MIND.md" : "USER.md";
          const altLimit = filename === "USER.md" ? 5000 : 2000;
          return {
            content:
              `${filename} is full: this write would be ${updated.length} chars (cap ${limit}). The write was NOT applied. RETRY in this same turn — pick ONE of:\n` +
              `  (a) call again with action='replace_section' and section_heading set to a stale/redundant section. Existing sections in ${filename}: ${sectionHeadings.join(" | ")}\n` +
              `  (b) call again with action='full_replace' after reading the file — keep only what's still relevant; aim for ~${Math.round(limit * 0.7)} chars to leave growth room\n` +
              `  (c) if this content is more procedural/workflow than profile/preference, call again with file='${altTarget}' (writes to ${altFile}, ${altLimit} char cap)\n` +
              `Don't drop the write. Don't claim "saved!" — the user will think it persisted when it didn't. Pick one of the three retries above and execute it now.`,
            isError: false,
          };
        }

        // Profile-file safety net: collapse any duplicate top-level blocks
        // before persisting. Tool description steers the model toward
        // replace_section, but bad calls (`append` of a fresh "# About Me"
        // when one exists) used to corrupt the file permanently. This
        // catches that at the funnel.
        if (filename === "USER.md" || filename === "IDENTITY.md" || filename === "HEART.md") {
          updated = dedupeProfileMarkdown(updated);
        }

        try {
          writeMemorySafely({
            content: updated,
            source: "tool",
            target: filePath,
            mode: "overwrite",
          });
        } catch (e) {
          if (e instanceof MemoryWriteBlocked) {
            return { content: `BLOCKED: ${e.reason}`, isError: true };
          }
          throw e;
        }
        memory.markDirty();

        return {
          content: `Updated ${filename} (${action}${action === "replace_section" ? `: ${args.section_heading}` : ""}, now ${updated.length}${limit ? `/${limit}` : ""} chars)`,
        };
      },
    },
  ];
}

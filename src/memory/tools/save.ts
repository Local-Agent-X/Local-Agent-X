import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "../../memory/index.js";
import { PERSONALITY_FILES, dedupeProfileMarkdown, setUserScalarField } from "../personality.js";
import {
  writeMemorySafely,
  appendToDailyLogSafely,
  MemoryWriteBlocked,
} from "../write-safely.js";

export function createSaveTools(memory: MemoryIndex) {
  return [
    {
      name: "memory_save",
      description:
        "Append a line to today's daily conversation log. Use for transient session context that should be recoverable but isn't a durable fact. " +
        "For durable facts (preferences, environment, project knowledge), call `remember` instead — it stores in the indexed fact DB " +
        "that gets injected into future sessions.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The line to append to today's daily log" },
        },
        required: ["content"],
      },
      async execute(args: Record<string, unknown>) {
        const rawContent = String(args.content || "");
        const sessionId = args._sessionId ? String(args._sessionId) : undefined;

        if (!rawContent.trim()) {
          return { content: "Nothing to save.", isError: true };
        }

        try {
          appendToDailyLogSafely({
            memory,
            source: "tool",
            content: rawContent,
            sessionId,
          });
          return {
            content: `Saved to daily log (${new Date().toISOString().split("T")[0]})`,
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
      name: "memory_set_user_field",
      description:
        "Surgically set ONE scalar field in USER.md (Name, Location, Job/Role, Communication style, Interests, Pronouns). " +
        "Use this WHENEVER the user states a personal scalar fact — 'my name is X', 'I'm a Y', 'call me Z', 'I prefer pronouns A/B'. " +
        "Always prefer this over memory_update_profile for scalar facts: it patches the canonical line in the 'About Me' block, " +
        "creates the field if missing, and overwrites any prior value. No action/heading guesswork that can corrupt the file.",
      parameters: {
        type: "object",
        properties: {
          field: {
            type: "string",
            description: "Canonical field name (Name, Location, Job, Role, Pronouns, Interests, Communication style, etc.). Matched case-insensitively against existing bullets; created in the 'About Me' block if absent.",
          },
          value: {
            type: "string",
            description: "The new value. Empty string clears the field.",
          },
        },
        required: ["field", "value"],
      },
      async execute(args: Record<string, unknown>) {
        const field = String(args.field || "").trim();
        const value = String(args.value || "").trim();
        if (!field) {
          return { content: "field is required", isError: true };
        }
        const filePath = join(memory["memoryDir"], "USER.md");
        const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
        const updated = setUserScalarField(existing, field, value);
        // Funnel through the same dedupe + safety gate every other write uses.
        const safe = dedupeProfileMarkdown(updated);
        try {
          writeMemorySafely({
            content: safe,
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
        return { content: `USER.md: ${field} = ${value || "(cleared)"}` };
      },
    },

    {
      name: "memory_update_profile",
      description:
        "Edit a narrative profile file — multi-paragraph user background, agent personality, or agent identity. " +
        "Files: 'user' (USER.md — preferences, workflow, communication style — bounded ~2000 chars), " +
        "'heart' (HEART.md — your personality), 'identity' (IDENTITY.md — your name/vibe). " +
        "**Do NOT use this for scalar identity fields** (Name, Location, Job/Role, Pronouns, Communication style). " +
        "For those, use memory_set_user_field — it patches the canonical bullet directly with no action/heading guesswork. " +
        "**Do NOT use this for individual durable facts** (preferences, environment, project conventions, names). " +
        "For those, use `remember` — it stores in the indexed Facts DB which is properly queryable and updatable. " +
        "This tool is reserved for narrative profile content that doesn't fit single-sentence facts. " +
        "Prefer action='replace_section' over 'append'.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            enum: ["user", "heart", "identity"],
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
            content: `Unknown file: ${fileKey}. Use: user, heart, or identity (MIND.md is retired — use 'remember' for facts).`,
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

        // Char-limit enforcement on USER.md. Bounded narrative files force
        // the model to consolidate instead of append-forever. 'heart' and
        // 'identity' are user-author content with no limit — they're not
        // append targets.
        const PROFILE_CHAR_LIMITS: Record<string, number> = {
          "USER.md": 2000,
        };
        const limit = PROFILE_CHAR_LIMITS[filename];
        if (limit !== undefined && updated.length > limit) {
          // NOT an error — return as `isError: false` so the model treats
          // it as a retry hint rather than a terminal failure. Live testing
          // showed Codex giving up after one over-limit response when this
          // returned isError:true; treating it as guidance produces the
          // intended retry behavior.
          const sectionHeadings = Array.from(existing.matchAll(/^##?\s+([^\n]+)/gm))
            .map(m => m[1].trim())
            .slice(0, 12);
          return {
            content:
              `${filename} is full: this write would be ${updated.length} chars (cap ${limit}). The write was NOT applied. RETRY in this same turn — pick ONE of:\n` +
              `  (a) call again with action='replace_section' and section_heading set to a stale/redundant section. Existing sections in ${filename}: ${sectionHeadings.join(" | ")}\n` +
              `  (b) call again with action='full_replace' after reading the file — keep only what's still relevant; aim for ~${Math.round(limit * 0.7)} chars to leave growth room\n` +
              `  (c) if this content is an individual durable fact, call \`remember\` instead (Facts DB has no per-file cap)\n` +
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

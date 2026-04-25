import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryIndex } from "../../memory.js";
import { atomicWriteFileSync } from "../utils.js";
import { PERSONALITY_FILES } from "../personality.js";

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
        let content = String(args.content || "");
        const target = String(args.target || "daily");

        if (!content.trim()) {
          return { content: "Nothing to save.", isError: true };
        }

        // Memory taint protection: block external/injected content from persisting
        // This prevents the attack chain: malicious webpage → memory_save → permanent instruction hijack
        try {
          const { checkMemoryTaint, sanitizeForMemory, stripControlChars, normalizeHomoglyphs } = await import("../../sanitize.js");
          // Step 1: Cryptographic normalization — strip ALL unicode tricks before checking
          content = normalizeHomoglyphs(stripControlChars(content));
          // Step 2: Taint check on normalized content
          const taint = checkMemoryTaint(content);
          if (!taint.safe) {
            return {
              content: `BLOCKED: ${taint.reason}`,
              isError: true,
            };
          }
          // Step 3: Final sanitization pass (strip any remaining markers)
          content = sanitizeForMemory(content);
        } catch {
          // Sanitize module not available — allow (fail-open for backwards compat)
        }

        if (target === "memory") {
          const existing = memory.readMemoryFile();
          memory.writeMemoryFile(existing + (existing ? "\n\n" : "") + content);
          return { content: "Saved to MIND.md" };
        } else if (target === "retain") {
          // Parse structured fact line(s)
          const facts = memory.retain(content, "agent-tool");
          if (facts.length === 0) {
            // If not in structured format, save as observation
            const facts2 = memory.retain(
              `- S ${content}`,
              "agent-tool"
            );
            return {
              content: `Retained ${facts2.length} fact(s) as observation`,
            };
          }
          return {
            content: `Retained ${facts.length} fact(s): ${facts.map((f) => `[${f.kind}] ${f.content.slice(0, 60)}`).join("; ")}`,
          };
        } else {
          memory.appendDailyLog(content);
          return {
            content: `Saved to daily log (${new Date().toISOString().split("T")[0]})`,
          };
        }
      },
    },

    {
      name: "memory_update_profile",
      description:
        "Update a personality/profile file. Use this to evolve knowledge about the user or to adjust agent behavior based on what you learn. Files: 'user' (USER.md — who they are), 'heart' (HEART.md — your personality), 'identity' (IDENTITY.md — your name/vibe), 'mind' or 'memory' (MIND.md — core facts/knowledge). You can replace specific sections or append new information.",
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
          // Backup the existing file before full replace
          if (existing.trim()) {
            const backupPath = filePath + ".bak";
            try {
              atomicWriteFileSync(backupPath, existing);
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

        atomicWriteFileSync(filePath, updated);
        memory.markDirty();

        return {
          content: `Updated ${filename} (${action}${action === "replace_section" ? `: ${args.section_heading}` : ""})`,
        };
      },
    },
  ];
}

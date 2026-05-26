import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { MemoryIndex } from "../../../memory.js";

export function memoryGetTool(memory: MemoryIndex) {
  return {
    name: "memory_get",
    description:
      "Read a specific memory file by path. Use to retrieve USER.md, a daily log, or an entity page.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "File path within memory dir (e.g. USER.md, 2026-03-22.md, bank/entities/peter.md)",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>) {
      const requestedPath = String(args.path || "");

      // Path traversal protection: resolve and verify it stays within memory dir
      const memDir = resolve(memory["memoryDir"]);
      const fullPath = resolve(memDir, requestedPath);
      const rel = relative(memDir, fullPath);
      if (rel.startsWith("..") || isAbsolute(requestedPath)) {
        return {
          content: "BLOCKED: path traversal detected. Only files within the memory directory are accessible.",
          isError: true,
        };
      }

      if (!existsSync(fullPath)) {
        return { content: `Memory file not found: ${requestedPath}` };
      }

      try {
        const content = readFileSync(fullPath, "utf-8");
        return { content: content || "(empty file)" };
      } catch (e) {
        return {
          content: `Error reading memory file: ${(e as Error).message}`,
          isError: true,
        };
      }
    },
  };
}

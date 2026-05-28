import type { ToolResult } from "../types.js";

export interface ParallelResult {
  toolName: string;
  status: "fulfilled" | "rejected";
  result?: ToolResult;
  error?: string;
  durationMs: number;
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

type ExecuteFn = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

const READONLY_TOOLS = new Set([
  "memory_search",
  "memory_recall",
  "memory_get",
  "memory_stats",
  "web_search",
  "read",
  "view_image",
  "browser",
  "screen_capture",
  "camera_capture",
  "ocr",
  "mission_list",
  "mission_get",
]);

const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "memory_save",
  "memory_update_profile",
  "memory_reflect",
  "generate_image",
  "generate_video",
  "mission_build",
  "mission_edit",
  "mission_delete",
  "mission_save_preference",
  "mission_variables_set",
]);

function isReadonly(toolName: string): boolean {
  if (READONLY_TOOLS.has(toolName)) return true;
  if (MUTATING_TOOLS.has(toolName)) return false;
  // Unknown tools default to mutating for safety
  return false;
}

export function canRunParallel(toolCalls: ToolCall[]): boolean {
  if (toolCalls.length <= 1) return false;
  return toolCalls.every((tc) => isReadonly(tc.name));
}

export async function executeParallel(
  toolCalls: ToolCall[],
  executeFn: ExecuteFn,
): Promise<ParallelResult[]> {
  if (!canRunParallel(toolCalls)) {
    return executeSequential(toolCalls, executeFn);
  }

  const settled = await Promise.allSettled(
    toolCalls.map(async (tc) => {
      const start = Date.now();
      const result = await executeFn(tc.name, tc.args);
      return { toolName: tc.name, result, durationMs: Date.now() - start };
    }),
  );

  return settled.map((outcome, i) => {
    if (outcome.status === "fulfilled") {
      return {
        toolName: outcome.value.toolName,
        status: "fulfilled" as const,
        result: outcome.value.result,
        durationMs: outcome.value.durationMs,
      };
    }
    return {
      toolName: toolCalls[i].name,
      status: "rejected" as const,
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      durationMs: 0,
    };
  });
}

async function executeSequential(
  toolCalls: ToolCall[],
  executeFn: ExecuteFn,
): Promise<ParallelResult[]> {
  const results: ParallelResult[] = [];
  for (const tc of toolCalls) {
    const start = Date.now();
    try {
      const result = await executeFn(tc.name, tc.args);
      results.push({
        toolName: tc.name,
        status: "fulfilled",
        result,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        toolName: tc.name,
        status: "rejected",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }
  return results;
}

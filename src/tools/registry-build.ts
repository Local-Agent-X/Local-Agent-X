import type { ToolDefinition } from "../types.js";
import { createToolSearchTool } from "../tool-search.js";
import { type UnifiedToolRegistry, unifiedRegistry } from "./registry.js";
import { buildToolPromptSection } from "../tool-prompt-builder.js";
import { applyPrompts } from "./result-helpers.js";
import { tagToolsByAudience } from "../agent-request/audience-tagger.js";
import { readTool, writeTool, editTool } from "./file-tools.js";
import { bashTool } from "./shell-tools.js";
import { processTools } from "./process-tools.js";
import { webFetchTool } from "./web-tools.js";
import { viewImageTool, screenCaptureTool, listMonitorsTool, cameraCaptureTool, ocrTool } from "./vision-tools.js";
import { buildAppTool } from "./build-app.js";
import { createPageTool } from "./create-page-tool.js";
import { extractSiteAssetsTool } from "./asset-tools.js";
import { youtubeAnalyzeTool } from "../youtube-tool.js";
import { globTool } from "../glob-tool.js";
import { grepTool } from "../grep-tool.js";
import { webSearchTool } from "../web-search-tool.js";
import { askUserTool } from "../ask-user-tool.js";
import { spreadsheetTools } from "../spreadsheet-tools.js";
import { documentTools } from "../document-tools.js";
import { presentationTools } from "../presentation-tools.js";
import { pdfTools } from "../pdf-tools.js";
import { emailTools } from "../email-tools.js";
import { calendarTools } from "../calendar-tools.js";
import { clipboardTools } from "../clipboard-tools.js";
import { sqlTools } from "../sql-tools.js";
import { taskTools } from "../task-tools.js";
import { planTools } from "../plan-tools.js";
import { buildDreamPrompt } from "../memory-dream.js";
import { configTools } from "../config-tool.js";
import { selfEditTool } from "../self-edit-tool.js";
import { primalRunBuildPlanTool } from "../primal-auto-build/tool.js";
import { startAppBuildTool, finalizeAppBuildTool } from "../primal-auto-build/app-build-tool.js";
import { primalBuildStatusTool, primalBuildResumeTool } from "../primal-auto-build/orchestrator/tools.js";
import { autopilotTools } from "../autopilot/tools.js";
import { opTools } from "../ops/tools.js";
// Legacy skill_list/skill_run tools removed — protocol_list / protocol_get cover the same surface.
// SKILL.md files are still recognized as an import format via src/protocols/skill-md-parser.ts.

const _toolSearchTool = createToolSearchTool(unifiedRegistry);

export const allTools: ToolDefinition[] = applyPrompts([
  readTool, writeTool, editTool, bashTool, webFetchTool,
  globTool, grepTool, webSearchTool, askUserTool, _toolSearchTool,
  selfEditTool, primalRunBuildPlanTool, startAppBuildTool, finalizeAppBuildTool,
  primalBuildStatusTool, primalBuildResumeTool,
  viewImageTool, screenCaptureTool, listMonitorsTool, cameraCaptureTool, ocrTool,
  buildAppTool,
  youtubeAnalyzeTool, createPageTool, extractSiteAssetsTool,
  ...processTools,
  ...spreadsheetTools, ...documentTools, ...presentationTools, ...pdfTools,
  ...emailTools, ...calendarTools, ...clipboardTools, ...sqlTools,
  ...taskTools, ...planTools, ...configTools, ...autopilotTools, ...opTools,
  {
    name: "memory_dream",
    description: "Trigger a memory consolidation (dream). Reviews recent sessions, extracts facts, runs reflection and consolidation, and reorganizes memory files. Returns a summary of what was processed.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(): Promise<{ content: string; metadata?: Record<string, unknown> }> {
      const results: string[] = [];
      try {
        const { MemoryConsolidator } = await import("../memory-consolidation.js");
        const report = MemoryConsolidator.getInstance().consolidate();
        results.push(`Consolidation: merged=${report.mergedCount} promoted=${report.promotedCount} entities=${report.entityPagesUpdated} contradictions=${report.contradictionsFound}`);
      } catch (e) { results.push(`Consolidation failed: ${(e as Error).message}`); }
      try {
        const { completeDream, startDream } = await import("../memory-dream.js");
        startDream();
        completeDream(0);
        results.push("Dream state updated");
      } catch (e) { results.push(`Dream state update failed: ${(e as Error).message}`); }
      results.push("\n--- LLM Dream Prompt (for deeper consolidation) ---\n" + buildDreamPrompt());
      return { content: results.join("\n"), metadata: { isDreamPrompt: true } };
    },
  } satisfies ToolDefinition,
  {
    name: "doctor",
    description: "Run system self-diagnostics. Checks API keys, connectivity, dependencies, config, workspace, database, and tools. Returns actionable results.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(): Promise<{ content: string }> {
      const { runDoctor, formatDoctorReport } = await import("../doctor.js");
      const report = await runDoctor();
      return { content: formatDoctorReport(report) };
    },
  } satisfies ToolDefinition,
  {
    name: "usage_report",
    description: "Get token usage and cost report. Shows spending by model, session, and time period. Use 'today' for today's costs, 'session' for current session, or 'all' for everything.",
    parameters: { type: "object", properties: { period: { type: "string", enum: ["today", "session", "week", "all"], description: "Time period for the report" }, sessionId: { type: "string", description: "Specific session ID (optional)" } }, required: [] },
    async execute(args): Promise<{ content: string }> {
      const { getUsageSummary, getTodayCost } = await import("../cost-tracker.js");
      const period = (args.period as string) || "today";
      if (period === "today") {
        const today = getTodayCost();
        return { content: `Today's usage: ${today.inputTokens.toLocaleString()} input + ${today.outputTokens.toLocaleString()} output tokens | Cost: $${today.costUsd.toFixed(2)}` };
      }
      const since = period === "week" ? Date.now() - 7 * 86400000 : undefined;
      const sessionFilter = period === "session" ? (args.sessionId as string || args._sessionId as string || undefined) : (args.sessionId as string | undefined);
      const summary = getUsageSummary({ since, sessionId: sessionFilter });
      const lines = [`Usage Report (${period})`, `Total: ${summary.totalInputTokens.toLocaleString()} in + ${summary.totalOutputTokens.toLocaleString()} out | $${summary.totalCostUsd.toFixed(2)}`, "", "By Model:"];
      for (const [model, data] of Object.entries(summary.byModel)) {
        lines.push(`  ${model}: ${data.input.toLocaleString()} in + ${data.output.toLocaleString()} out | $${data.cost.toFixed(4)}`);
      }
      return { content: lines.join("\n") };
    },
  } satisfies ToolDefinition,
]);

export function buildToolRegistry(): { registry: UnifiedToolRegistry; eagerTools: ToolDefinition[]; toolSearchTool: ToolDefinition; promptSection: string } {
  // Tag every tool's `audiences` field from the legacy Sets BEFORE
  // registry insertion so the canonical resolver (tool-search.ts:
  // resolveToolsForRequest) has accurate audience info. Transitional —
  // tagToolsByAudience folds into ToolDefinition declarations later.
  tagToolsByAudience(allTools);

  for (const tool of allTools) {
    if (unifiedRegistry.get(tool.name)) continue;
    // Deferred = no audiences (not visible in any per-request schema).
    // Eager = at least one audience. tool_search still indexes both.
    const defer = !tool.audiences || tool.audiences.length === 0;
    unifiedRegistry.register(tool, { defer, tags: [], searchHint: tool.description.slice(0, 80) });
  }

  const eagerTools = unifiedRegistry.getEagerTools();
  const promptSection = buildToolPromptSection(allTools);

  return { registry: unifiedRegistry, eagerTools, toolSearchTool: _toolSearchTool, promptSection };
}

export function getAllTools(): ToolDefinition[] {
  return allTools;
}

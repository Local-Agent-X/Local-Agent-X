/**
 * Local Agent X — self_edit tool barrel.
 *
 * Real implementation lives in src/self-edit/*. See tool.ts for the
 * orchestrator and module-by-module breakdown of the gates, session lock,
 * prompt builder, and bypass runner.
 */

export { selfEditTool } from "./self-edit/tool.js";

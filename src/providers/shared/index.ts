/**
 * Shared adapter helpers — stable cross-provider primitives. Adapters
 * pull from here instead of duplicating tool-shape conversions, SSE
 * parsing, etc.
 */

export { parseSSE } from "./sse-parser.js";
export { toOpenAITools, toAnthropicTools } from "./tool-shape.js";
export type { OpenAITool, AnthropicTool } from "./tool-shape.js";

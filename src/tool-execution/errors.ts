// ToolBlocked is re-exported from pre-dispatch so consumers don't reach
// across the boundary into tools/. Error classification lives in
// ../resilience-policy.ts.

export { ToolBlocked } from "../tools/pre-dispatch.js";

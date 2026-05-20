import type { SecurityLayer } from "../security.js";

export function getRiskLevel(_toolName: string, _args: Record<string, unknown>, _security?: SecurityLayer): "low" | "medium" | "high" {
  return "low";
}

export function buildApprovalContext(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash":
      return `Run command: "${String(args.command || "").slice(0, 150)}"`;
    case "write":
      return `Create file: ${String(args.path || "").split(/[/\\]/).pop()} (${String(args.content || "").length} chars)`;
    case "edit":
      return `Edit file: ${String(args.path || "").split(/[/\\]/).pop()}`;
    case "read":
      return `Read file: ${String(args.path || "").split(/[/\\]/).pop()}`;
    case "browser": {
      const a = String(args.action || "");
      if (a === "navigate" || a === "new_tab") return `Open website: ${args.url || ""}`;
      if (a === "evaluate") return `Run script in browser: ${String(args.script || "").slice(0, 80)}`;
      return `Browser: ${a}`;
    }
    case "http_request":
      return `API call: ${args.method || "GET"} ${String(args.url || "").slice(0, 100)}`;
    case "web_fetch":
      return `Fetch webpage: ${String(args.url || "").slice(0, 100)}`;
    case "build_app":
      return `Build app: ${String(args.name || "")}`;
    default:
      return `${toolName}: ${JSON.stringify(args).slice(0, 80)}`;
  }
}

// Shared type definitions for the unified per-tool policy table. The table
// itself is assembled from per-domain fragments and merged in tool-policies.data.ts;
// these interfaces are the contract every fragment is typed against. They are
// re-exported unchanged from tool-policies.data.ts so existing importers (and
// tool-registry.ts) keep their import path.

import type { KernelClass, ToolRisk } from "../tool-registry.js";
import type { ToolPolicyRule } from "./types.js";

export interface ToolRateLimit {
  maxCalls: number;
  windowMs: number;
  action: "block" | "warn" | "throttle";
}

// A caller-supplied filesystem path that a tool opens. Declaring it here is
// what subjects the tool to the file-access mode (workspace/common/unrestricted)
// — SecurityLayer.evaluate() runs EVERY declared arg through evaluateFileAccess
// before dispatch, so the mode is a uniform hard boundary across every file sink
// (raw read/write, spreadsheet, document, presentation, pdf, ocr, image, search)
// rather than just the four raw fs tools. A tool that opens a path WITHOUT a
// declaration here silently bypasses confinement — that was the office-doc
// breach. The coverage test in tool-policies.test.ts guards the known sinks.
export interface PathArgSpec {
  /** Argument name holding the path (e.g. "file_path", "path", "output_path"). */
  arg: string;
  /** Action token handed to evaluateFileAccess. "write"/"edit" trigger write-
   *  confinement + core-file protection; "read"/"delete_file" gate as a read. */
  action: "read" | "write" | "edit" | "delete_file";
  /** Arg value is a JSON-array string of paths (pdf_merge.files). Each element
   *  is gated independently. */
  json?: boolean;
}

export interface ToolPolicyEntry {
  /** Present on concrete tools — feeds TOOLS / TOOL_CLASS_MAP / TOOL_RISK. */
  kernel?: KernelClass;
  risk?: ToolRisk;
  /** Explicit policy rule(s) for this tool or glob. `tool` is stamped from the
   *  record key by deriveDefaultRules — omit it here. */
  rules?: Array<Omit<ToolPolicyRule, "tool">>;
  /** Sliding-window rate cap (was DEFAULT_LIMITS in tool-execution/rate-limiter.ts). */
  rateLimit?: ToolRateLimit;
  /** Caller-supplied file path arg(s) this tool opens — gated through the file-
   *  access mode by SecurityLayer. See PathArgSpec. */
  pathArgs?: PathArgSpec[];
  /** This tool's implementation performs a NON-loopback fetch/upload with
   *  model-controlled content (a query/prompt/body/path that rides off-box to a
   *  remote API or messaging bridge) — i.e. it is a data-exfil egress sink.
   *  EVERY tool marked here MUST also be enrolled in EGRESS_TOOLS so the egress
   *  gates (taint floor, secret scan, canary tripwire) cover it; a build-time
   *  invariant (capability-class-gates.test.ts) fails the build if it drifts.
   *  A tool that only hits loopback (localhost Stable Diffusion / 127.0.0.1) is
   *  NOT off-box and must NOT be marked. */
  offBoxFetch?: boolean;
}
